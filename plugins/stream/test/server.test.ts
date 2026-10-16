/**
 * Server tests for the stream domain. The harness provides `stream.platform` for twitch:roman
 * and calls from the same plugin, so it acts as the platform.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessError, ValidationError, defineContract, definePlugin } from '@petalbot/sdk';
import { createTestHarness } from '@petalbot/testing';
import { streamContract, type StreamEvent } from '../src/contract.ts';
import { RECENT_LIMIT } from '../src/limits.ts';
import stream from '../src/server.ts';

const source = { platform: 'twitch', connection: 'twitch:roman' };
const twitch = { id: 'twitch:roman', platform: 'twitch', channel: 'roman', displayName: 'roman' };
const viewer = { id: 'u1', login: 'viewer', displayName: 'Viewer' };

async function connected() {
  const harness = await createTestHarness(stream, {
    providers: { 'stream.platform': { 'twitch:roman': {} } },
  });
  await harness.call('stream.registerConnection', twitch);
  return harness;
}

/** A second platform plugin that provides `key`, and its ctx. */
async function startPlatform(harness: Awaited<ReturnType<typeof connected>>, key: string) {
  type Ctx = Parameters<
    ReturnType<
      typeof definePlugin<{ id: 'kick'; version: '1.0.0' }, [typeof streamContract], []>
    >['setup']
  >[0];
  const holder: { ctx?: Ctx } = {};
  await harness.kernel.start(
    definePlugin(defineContract({ id: 'kick', version: '1.0.0' }), {
      dependencies: [streamContract],
      setup(ctx) {
        ctx.provide('stream.platform', key, {});
        holder.ctx = ctx;
      },
    }),
  );
  if (!holder.ctx) throw new Error('kick did not start');
  return holder.ctx;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(10_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('stream', () => {
  it('emits each ingested event under its own name, without the type', async () => {
    const harness = await connected();
    const events: StreamEvent[] = [
      { type: 'online', source, title: 'Hello', category: 'Chess' },
      { type: 'follow', source, user: viewer },
      { type: 'subscription', source, user: viewer, tier: 1, months: 3, message: 'hi' },
      { type: 'giftSubscription', source, count: 5, tier: 2 },
      { type: 'raid', source, from: viewer, viewers: 42 },
      { type: 'support', source, user: viewer, amount: 500, currency: 'bits' },
      { type: 'offline', source },
    ];
    for (const event of events) await harness.call('stream.ingest', event);
    await harness.idle();
    expect(harness.events.slice(1).map((event) => [event.name, event.payload])).toEqual(
      events.map(({ type, ...payload }) => [`stream.${type}`, payload]),
    );
    await harness.stop();
  });

  it('keeps the last events newest first', async () => {
    const harness = await connected();
    for (let n = 1; n <= RECENT_LIMIT + 1; n += 1) {
      await harness.call('stream.ingest', {
        type: 'follow',
        source,
        user: { ...viewer, id: `u${String(n)}` },
      });
    }
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
    await harness.call('stream.ingest', { type: 'online', source });
    await expect(harness.call('stream.status')).resolves.toEqual({
      'twitch:roman': { live: true, since: 10_000 },
    });
    await harness.call('stream.ingest', { type: 'offline', source });
    await expect(harness.call('stream.status')).resolves.toEqual({
      'twitch:roman': { live: false },
    });
    await harness.stop();
  });

  it("takes the platform's start time and keeps it on a repeated online", async () => {
    const harness = await connected();
    await harness.call('stream.ingest', { type: 'online', source, since: 4_000 });
    await harness.call('stream.ingest', { type: 'online', source });
    await expect(harness.call('stream.status')).resolves.toEqual({
      'twitch:roman': { live: true, since: 4_000 },
    });
    await harness.stop();
  });

  it('takes the live status a platform registers with', async () => {
    const harness = await connected();
    await harness.call('stream.registerConnection', { ...twitch, live: true, since: 5 });
    await expect(harness.call('stream.status')).resolves.toEqual({
      'twitch:roman': { live: true, since: 5 },
    });
    await harness.stop();
  });

  it('accepts registrations and events only from the providing plugin', async () => {
    const harness = await connected();
    const kick = await startPlatform(harness, 'kick:roman');
    await expect(kick.call('stream.ingest', { type: 'offline', source })).rejects.toBeInstanceOf(
      AccessError,
    );
    await expect(kick.call('stream.registerConnection', twitch)).rejects.toBeInstanceOf(
      AccessError,
    );
    await expect(
      harness.call('stream.registerConnection', { ...twitch, platform: 'kick' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      harness.call('stream.ingest', {
        type: 'offline',
        source: { platform: 'kick', connection: 'twitch:roman' },
      }),
    ).rejects.toBeInstanceOf(AccessError);
    await expect(harness.call('stream.recent')).resolves.toEqual([]);
    await harness.stop();
  });

  it('forgets a connection when its platform plugin stops, and says so', async () => {
    const harness = await connected();
    const kick = await startPlatform(harness, 'kick:roman');
    await kick.call('stream.registerConnection', { ...twitch, id: 'kick:roman', platform: 'kick' });
    await harness.kernel.stop('kick');
    await expect(harness.call('stream.status')).resolves.toEqual({
      'twitch:roman': { live: false },
    });
    await harness.idle();
    expect(
      harness.events.filter((event) => event.name === 'stream.connectionsChanged'),
    ).toHaveLength(3);
    await harness.stop();
  });
});
