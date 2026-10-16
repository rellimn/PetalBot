/**
 * Server tests for the chat domain, against fake providers.
 *
 * The harness adds the fake providers and pushes through their handles, so the harness is "the
 * platform" here.
 */
import { describe, expect, it, vi } from 'vitest';
import { ValidationError, fail, type PanelUser, type ProviderImpl } from '@petalbot/sdk';
import { createTestHarness } from '@petalbot/testing';
import chat from '../src/server.ts';
import { RECENT_LIMIT } from '../src/limits.ts';
import { permissionDenied, type chatContract } from '../src/contract.ts';
import {
  inbound,
  message,
  recordingLogger,
  startPlatform,
  startTap,
  twitch,
  twitchConnection,
  viewer,
} from './fixtures.ts';

type Fake = ProviderImpl<typeof chatContract.providers.platform>;

const sends = () =>
  vi.fn((input: { text: string }) =>
    Promise.resolve({ ok: true as const, messageId: `sent:${input.text}` }),
  );

const other = { channel: 'other', displayName: 'other', isDefault: false };

/** chat with one Twitch connection, twitch:roman, whose provider is `fake`. */
async function connected(
  fake: Fake,
  options: { logger?: ReturnType<typeof recordingLogger> } = {},
) {
  const harness = await createTestHarness(chat, options.logger ? { logger: options.logger } : {});
  const provided = harness.addProvider('chat.platform', 'twitch:roman', {
    info: twitch,
    methods: fake,
  });
  return Object.assign(harness, { provided });
}

const names = (events: readonly { name: string }[], name: string) =>
  events.filter((event) => event.name === name);

describe('chat connections', () => {
  it('lists live providers with the methods they implement', async () => {
    const harness = await connected({ send: sends(), delete: () => Promise.resolve({ ok: true }) });
    await expect(harness.call('chat.connections')).resolves.toEqual([
      { ...twitchConnection, capabilities: ['send', 'delete'] },
    ]);
    await harness.idle();
    expect(names(harness.events, 'chat.connectionsChanged')).toHaveLength(1);
    await harness.stop();
  });

  it('drops a connection when its provider goes away', async () => {
    const harness = await connected({ send: sends() });
    const second = harness.addProvider('chat.platform', 'twitch:other', {
      info: other,
      methods: { send: sends() },
    });
    second.dispose();
    await expect(harness.call('chat.connections')).resolves.toMatchObject([{ id: 'twitch:roman' }]);
    await expect(
      harness.call('chat.send', { target: { connection: 'twitch:other' }, text: 'hi' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'not-found',
      error: { code: 'connection-not-found', connection: 'twitch:other' },
      message: 'There is no chat connection "twitch:other"',
    });
    await harness.idle();
    expect(names(harness.events, 'chat.connectionsChanged')).toHaveLength(3);
    await harness.stop();
  });

  it('drops the connections of a platform plugin that stops', async () => {
    const harness = await createTestHarness(chat);
    await startPlatform(harness, 'kick', 'kick:roman');
    await expect(harness.call('chat.connections')).resolves.toMatchObject([{ id: 'kick:roman' }]);
    await harness.kernel.stop('kick');
    await expect(harness.call('chat.connections')).resolves.toEqual([]);
    await harness.stop();
  });

  it('keeps connections across a chat restart without registering again', async () => {
    const harness = await connected({ send: sends() });
    await harness.kernel.stop('chat');
    await harness.kernel.start(chat);
    await expect(harness.call('chat.connections')).resolves.toMatchObject([{ id: 'twitch:roman' }]);
    await expect(
      harness.call('chat.send', { target: { platform: 'twitch' }, text: 'hi' }),
    ).resolves.toEqual({ ok: true, messageId: 'sent:hi' });
    await harness.stop();
  });

  it('resolves a platform to its default connection, or to its only one', async () => {
    const harness = await connected({ send: sends() });
    harness.addProvider('chat.platform', 'twitch:other', {
      info: other,
      methods: { send: sends() },
    });
    await expect(
      harness.call('chat.send', { target: { platform: 'twitch' }, text: 'hi' }),
    ).resolves.toEqual({ ok: true, messageId: 'sent:hi' });
    harness.provided.update({ ...twitch, isDefault: false });
    await expect(
      harness.call('chat.send', { target: { platform: 'twitch' }, text: 'hi' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'custom',
      error: {
        code: 'ambiguous-target',
        platform: 'twitch',
        connections: ['twitch:roman', 'twitch:other'],
      },
      message: 'Several twitch chats are connected and none is the default',
    });
    await expect(
      harness.call('chat.send', { target: { platform: 'youtube' }, text: 'hi' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'not-found',
      error: { code: 'platform-not-connected', platform: 'youtube' },
      message: 'No youtube chat is connected',
    });
    await harness.stop();
  });

  it('follows an isDefault change made with update', async () => {
    const harness = await connected({ send: sends() });
    const second = harness.addProvider('chat.platform', 'twitch:other', {
      info: other,
      methods: { send: () => Promise.resolve({ ok: true, messageId: 'other-1' }) },
    });
    harness.provided.update({ ...twitch, isDefault: false });
    second.update({ ...other, isDefault: true });
    await expect(
      harness.call('chat.send', { target: { platform: 'twitch' }, text: 'hi' }),
    ).resolves.toEqual({ ok: true, messageId: 'other-1' });
    await expect(harness.call('chat.connections')).resolves.toMatchObject([
      { id: 'twitch:roman', isDefault: false },
      { id: 'twitch:other', isDefault: true },
    ]);
    await harness.idle();
    // added x2, updated x2
    expect(names(harness.events, 'chat.connectionsChanged')).toHaveLength(4);
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
      {
        connection: 'twitch:roman',
        text: 'hello',
        actor: { kind: 'plugin', pluginId: 'petalbot-test-caller' },
      },
    ]);
    expect(send).toHaveBeenCalledWith({ text: 'HELLO' });
    await harness.stop();
  });

  it('shows chat.beforeSend taps the panel user who sent', async () => {
    const harness = await connected({ send: sends() });
    const mia: PanelUser = { id: 'mia-id', name: 'mia', role: 'mod' };
    const seen: unknown[] = [];
    await startTap(harness, 'watcher', (input) => {
      seen.push(input.actor);
    });
    await harness.kernel.callFromClient(
      'chat.send',
      { target: { platform: 'twitch' }, text: 'hi' },
      { kind: 'panel', user: mia },
    );
    expect(seen).toEqual([{ kind: 'user', user: mia }]);
    await harness.stop();
  });

  it('answers provider-error when a provider never settles', async () => {
    vi.useFakeTimers();
    try {
      const harness = await connected({ send: () => new Promise(() => undefined) });
      const result = harness.call('chat.send', { target: { platform: 'twitch' }, text: 'hi' });
      await vi.advanceTimersByTimeAsync(12_000);
      await expect(result).resolves.toMatchObject({
        ok: false,
        reason: 'platform-error',
        error: { code: 'provider-error', connection: 'twitch:roman', capability: 'send' },
      });
      await harness.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a message-free domain failure returned by the provider', async () => {
    const harness = await connected({ send: () => Promise.resolve(fail(permissionDenied, {})) });
    await expect(
      harness.call('chat.send', { target: { connection: 'twitch:roman' }, text: 'hi' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'forbidden',
      error: { code: 'permission-denied' },
    });
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
      error: { code: 'send-vetoed', connection: 'twitch:roman', vetoedBy: 'filter' },
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
      error: { code: 'unsupported-capability', connection: 'twitch:roman', capability: 'send' },
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
      error: { code: 'provider-error', connection: 'twitch:roman', capability: 'send' },
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
        Promise.resolve({
          ok: false,
          reason: 'rate-limited',
          error: { code: 'rate-limited' },
          message: 'Twitch dropped it',
        }),
    });
    await expect(
      harness.call('chat.send', { target: { platform: 'twitch' }, text: 'hi' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'rate-limited',
      error: { code: 'rate-limited' },
      message: 'Twitch dropped it',
    });
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
    await startPlatform(harness, 'kick', 'kick:roman');
    harness.addProvider('chat.platform', 'youtube:roman', {
      info: { ...twitch, isDefault: false },
    });
    const all = harness.call('chat.broadcast', { text: 'Starting!' });
    release();
    await expect(all).resolves.toEqual({
      'twitch:roman': { ok: true, messageId: 't1' },
      'kick:roman': { ok: true, messageId: 'kick-1' },
      'youtube:roman': {
        ok: false,
        reason: 'unsupported',
        error: { code: 'unsupported-capability', connection: 'youtube:roman', capability: 'send' },
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
    await startPlatform(harness, 'kick', 'kick:roman');
    await startTap(harness, 'filter', (input, { veto }) =>
      input.connection === 'kick:roman' ? veto('not on kick') : undefined,
    );
    await expect(
      harness.call('chat.broadcast', {
        text: 'hi',
        connections: ['twitch:roman', 'kick:roman', 'twitch:gone'],
      }),
    ).resolves.toEqual({
      'twitch:gone': {
        ok: false,
        reason: 'not-found',
        error: { code: 'connection-not-found', connection: 'twitch:gone' },
        message: 'There is no chat connection "twitch:gone"',
      },
      'twitch:roman': { ok: true, messageId: 'sent:hi' },
      'kick:roman': {
        ok: false,
        reason: 'forbidden',
        error: { code: 'send-vetoed', connection: 'kick:roman', vetoedBy: 'filter' },
        message: 'Vetoed by filter: not on kick',
      },
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
        error: { code: 'connection-not-found', connection: 'twitch:gone' },
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
  it('emits pushed messages with the source taken from the provider key', async () => {
    const harness = await connected({});
    harness.provided.push('message', inbound('m1'));
    await harness.idle();
    expect(names(harness.events, 'chat.message')[0]).toMatchObject({
      payload: { id: 'm1', source: { platform: 'twitch', connection: 'twitch:roman' } },
    });
    await harness.stop();
  });

  it('keeps the last messages, oldest first', async () => {
    const harness = await connected({});
    for (let n = 1; n <= RECENT_LIMIT + 2; n += 1) {
      harness.provided.push('message', inbound(`m${String(n)}`));
    }
    await harness.idle();
    const recent = await harness.call('chat.recent');
    expect(recent).toHaveLength(RECENT_LIMIT);
    expect(recent[0]).toEqual({ ...message('m3'), deleted: false });
    expect(recent.at(-1)?.id).toBe(`m${String(RECENT_LIMIT + 2)}`);
    expect(names(harness.events, 'chat.message')).toHaveLength(RECENT_LIMIT + 2);
    await harness.stop();
  });

  it('marks deleted messages and announces the deletion', async () => {
    const harness = await connected({});
    harness.provided.push('message', inbound('m1'));
    harness.provided.push('message', inbound('m2'));
    harness.provided.push('messageDeleted', { messageId: 'm1' });
    await harness.idle();
    await expect(harness.call('chat.recent')).resolves.toMatchObject([
      { id: 'm1', deleted: true },
      { id: 'm2', deleted: false },
    ]);
    expect(harness.events.at(-1)).toMatchObject({
      name: 'chat.messageDeleted',
      payload: { source: { platform: 'twitch', connection: 'twitch:roman' }, messageId: 'm1' },
    });
    await harness.stop();
  });

  it('drops a message the platform delivers twice', async () => {
    const harness = await connected({});
    harness.provided.push('message', inbound('m1'));
    harness.provided.push('message', inbound('m1', { text: 'again' }));
    await harness.idle();
    await expect(harness.call('chat.recent')).resolves.toMatchObject([
      { id: 'm1', text: 'message m1' },
    ]);
    expect(names(harness.events, 'chat.message')).toHaveLength(1);
    await harness.stop();
  });

  it('tells apart equal message ids from different connections', async () => {
    const harness = await connected({});
    const second = harness.addProvider('chat.platform', 'twitch:other', { info: other });
    harness.provided.push('message', inbound('m1'));
    second.push('message', inbound('m1'));
    second.push('messageDeleted', { messageId: 'm1' });
    await harness.idle();
    await expect(harness.call('chat.recent')).resolves.toMatchObject([
      { id: 'm1', source: { connection: 'twitch:roman' }, deleted: false },
      { id: 'm1', source: { connection: 'twitch:other' }, deleted: true },
    ]);
    await harness.stop();
  });

  it('rejects a malformed push at the platform and emits nothing', async () => {
    const harness = await connected({});
    expect(() => {
      harness.provided.push('message', { ...inbound('m1'), id: '' });
    }).toThrow(ValidationError);
    await harness.idle();
    expect(names(harness.events, 'chat.message')).toEqual([]);
    await harness.stop();
  });
});
