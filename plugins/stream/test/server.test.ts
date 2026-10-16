/**
 * Server tests for the stream domain. The harness adds the `stream.platform` provider for
 * twitch:roman and pushes through it, so it acts as the platform.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError, defineContract, definePlugin } from '@petalbot/sdk';
import { createTestHarness } from '@petalbot/testing';
import { streamContract, type InboundStreamEvent } from '../src/contract.ts';
import { RECENT_LIMIT } from '../src/limits.ts';
import stream from '../src/server.ts';

const source = { platform: 'twitch', connection: 'twitch:roman' };
const twitch = { channel: 'roman', displayName: 'roman' };
const viewer = { id: 'u1', login: 'viewer', displayName: 'Viewer' };

async function connected(info: { live?: boolean; since?: number } = {}) {
  const harness = await createTestHarness(stream);
  const provided = harness.addProvider('stream.platform', 'twitch:roman', {
    info: { ...twitch, ...info },
  });
  return Object.assign(harness, { provided });
}

/** A second platform plugin that provides `key`. */
async function startPlatform(harness: Awaited<ReturnType<typeof connected>>, key: string) {
  await harness.kernel.start(
    definePlugin(defineContract({ id: 'kick', version: '1.0.0' }), {
      dependencies: [streamContract],
      setup(ctx) {
        ctx.provide('stream.platform', key, { info: twitch });
      },
    }),
  );
}

const changes = (harness: Awaited<ReturnType<typeof connected>>) =>
  harness.events.filter((event) => event.name === 'stream.connectionsChanged');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(10_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('stream', () => {
  it('emits each pushed event under its own name, with the source and without the type', async () => {
    const harness = await connected();
    const events: InboundStreamEvent[] = [
      { type: 'online', title: 'Hello', category: 'Chess' },
      { type: 'follow', user: viewer },
      { type: 'subscription', user: viewer, tier: 1, months: 3, message: 'hi' },
      { type: 'giftSubscription', count: 5, tier: 2 },
      { type: 'raid', from: viewer, viewers: 42 },
      { type: 'support', user: viewer, amount: 500, currency: 'bits' },
      { type: 'offline' },
    ];
    for (const event of events) harness.provided.push('event', event);
    await harness.idle();
    expect(
      harness.events
        .filter((event) => event.name !== 'stream.connectionsChanged')
        .map((event) => [event.name, event.payload]),
    ).toEqual(events.map(({ type, ...payload }) => [`stream.${type}`, { ...payload, source }]));
    await harness.stop();
  });

  it('keeps the last events newest first', async () => {
    const harness = await connected();
    for (let n = 1; n <= RECENT_LIMIT + 1; n += 1) {
      harness.provided.push('event', { type: 'follow', user: { ...viewer, id: `u${String(n)}` } });
    }
    await harness.idle();
    const recent = await harness.call('stream.recent');
    expect(recent).toHaveLength(RECENT_LIMIT);
    expect(recent[0]).toEqual({
      id: expect.any(String) as string,
      timestamp: 10_000,
      event: { type: 'follow', source, user: { ...viewer, id: `u${String(RECENT_LIMIT + 1)}` } },
    });
    expect(recent.at(-1)?.event).toMatchObject({ user: { id: 'u2' } });
    await harness.stop();
  });

  it('tracks whether each connection is live', async () => {
    const harness = await connected();
    await expect(harness.call('stream.status')).resolves.toEqual({
      'twitch:roman': { live: false },
    });
    harness.provided.push('event', { type: 'online' });
    await harness.idle();
    await expect(harness.call('stream.status')).resolves.toEqual({
      'twitch:roman': { live: true, since: 10_000 },
    });
    harness.provided.push('event', { type: 'offline' });
    await harness.idle();
    await expect(harness.call('stream.status')).resolves.toEqual({
      'twitch:roman': { live: false },
    });
    await harness.stop();
  });

  it("takes the platform's start time and keeps it on a repeated online", async () => {
    const harness = await connected();
    harness.provided.push('event', { type: 'online', since: 4_000 });
    harness.provided.push('event', { type: 'online' });
    await harness.idle();
    await expect(harness.call('stream.status')).resolves.toEqual({
      'twitch:roman': { live: true, since: 4_000 },
    });
    await harness.stop();
  });

  it('takes the live status a platform registers with', async () => {
    const harness = await connected({ live: true, since: 5 });
    await expect(harness.call('stream.status')).resolves.toEqual({
      'twitch:roman': { live: true, since: 5 },
    });
    await harness.stop();
  });

  it('takes live status from update', async () => {
    const harness = await connected();
    harness.provided.update({ ...twitch, live: true, since: 7 });
    await expect(harness.call('stream.status')).resolves.toEqual({
      'twitch:roman': { live: true, since: 7 },
    });
    await harness.idle();
    expect(changes(harness)).toHaveLength(2);
    await harness.stop();
  });

  it('rejects a malformed push at the platform and emits nothing', async () => {
    const harness = await connected();
    expect(() => {
      harness.provided.push('event', { type: 'raid', from: viewer, viewers: -1 });
    }).toThrow(ValidationError);
    await harness.idle();
    await expect(harness.call('stream.recent')).resolves.toEqual([]);
    await harness.stop();
  });

  it('keeps connections and their live status across a stream restart', async () => {
    const harness = await connected({ live: true, since: 5 });
    await harness.kernel.stop('stream');
    await harness.kernel.start(stream);
    await expect(harness.call('stream.status')).resolves.toEqual({
      'twitch:roman': { live: true, since: 5 },
    });
    await harness.stop();
  });

  it('forgets a connection when its platform plugin stops, and says so', async () => {
    const harness = await connected();
    await startPlatform(harness, 'kick:roman');
    await expect(harness.call('stream.status')).resolves.toEqual({
      'twitch:roman': { live: false },
      'kick:roman': { live: false },
    });
    await harness.kernel.stop('kick');
    await expect(harness.call('stream.status')).resolves.toEqual({
      'twitch:roman': { live: false },
    });
    await harness.idle();
    expect(changes(harness)).toHaveLength(3);
    await harness.stop();
  });
});
