/**
 * Server tests for the counter.
 *
 * createTestHarness (@petalbot/testing) runs the plugin in a real PetalBot core on an in-memory
 * database. It applies the real migrations from drizzle/: it finds the plugin folder by walking
 * up from this file to the package.json with a "petalbot" field. `harness.call` calls RPCs the
 * way another plugin would, and `harness.events` records every event.
 */
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@petalbot/sdk';
import { createTestHarness } from '@petalbot/testing';
import counter from '../src/server.ts';

/** The harness's caller is a plugin with this id, so `who` (and the events' `by`) is this. */
const CALLER = 'petalbot-test-caller';

const start = (step = 1) => createTestHarness(counter, { settings: { step } });

describe('counter plugin', () => {
  it('creates counters and lists them by name, with their choices', async () => {
    const harness = await start();
    const wins = await harness.call('counter.create', { name: 'Wins' });
    const deaths = await harness.call('counter.create', { name: 'Deaths' });
    expect(deaths).toEqual({ id: expect.any(String) as string, name: 'Deaths', value: 0 });
    await expect(harness.call('counter.list')).resolves.toEqual([deaths, wins]);
    await expect(harness.call('counter.options')).resolves.toEqual([
      { value: deaths.id, label: 'Deaths' },
      { value: wins.id, label: 'Wins' },
    ]);
    await harness.idle();
    expect(harness.events.map((event) => event.name)).toEqual([
      'counter.listChanged',
      'counter.listChanged',
    ]);
    await harness.stop();
  });

  it('counts in steps from the settings and announces who changed what', async () => {
    const harness = await start(5);
    const { id } = await harness.call('counter.create', { name: 'Deaths' });
    await harness.call('counter.increment', { counter: id });
    await expect(harness.call('counter.increment', { counter: id })).resolves.toEqual({
      ok: true,
      counter: { id, name: 'Deaths', value: 10 },
    });
    await harness.idle();
    const changes = harness.events.filter((event) => event.name === 'counter.changed');
    expect(changes.map((event) => event.payload)).toEqual([
      { counter: id, value: 5, by: CALLER },
      { counter: id, value: 10, by: CALLER },
    ]);
    await harness.stop();
  });

  it('stays exact under concurrent increments', async () => {
    // Each increment is one UPDATE … RETURNING statement, so none can overwrite another.
    const harness = await start();
    const { id } = await harness.call('counter.create', { name: 'Clicks' });
    await Promise.all(
      Array.from({ length: 100 }, () => harness.call('counter.increment', { counter: id })),
    );
    await expect(harness.call('counter.get', { counter: id })).resolves.toMatchObject({
      value: 100,
    });
    await harness.stop();
  });

  it('answers not-found for unknown counters instead of throwing', async () => {
    const harness = await start();
    const notFound = { ok: false, reason: 'not-found', message: 'There is no counter "nope"' };
    await expect(harness.call('counter.increment', { counter: 'nope' })).resolves.toEqual(notFound);
    await expect(harness.call('counter.reset', { counter: 'nope' })).resolves.toEqual(notFound);
    await expect(harness.call('counter.remove', { counter: 'nope' })).resolves.toEqual(notFound);
    await expect(harness.call('counter.get', { counter: 'nope' })).resolves.toBeNull();
    await harness.stop();
  });

  it('rejects a duplicate name with a validation issue on the name', async () => {
    const harness = await start();
    await harness.call('counter.create', { name: 'Deaths' });
    const error = await harness
      .call('counter.create', { name: 'Deaths' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    const issues = (error as ValidationError).issues.map((issue) => [issue.path, issue.message]);
    expect(issues).toEqual([[['name'], 'A counter with this name already exists']]);
    await expect(harness.call('counter.list')).resolves.toHaveLength(1);
    await harness.stop();
  });

  it('resets and removes counters', async () => {
    const harness = await start();
    const { id } = await harness.call('counter.create', { name: 'Deaths' });
    await harness.call('counter.increment', { counter: id });
    await expect(harness.call('counter.reset', { counter: id })).resolves.toEqual({
      ok: true,
      counter: { id, name: 'Deaths', value: 0 },
    });
    await expect(harness.call('counter.remove', { counter: id })).resolves.toEqual({ ok: true });
    await expect(harness.call('counter.get', { counter: id })).resolves.toBeNull();
    await expect(harness.call('counter.list')).resolves.toEqual([]);
    await harness.stop();
  });

  it('uses a new step as soon as the settings change', async () => {
    const harness = await start(1);
    const { id } = await harness.call('counter.create', { name: 'Deaths' });
    await harness.updateSettings({ step: 3 });
    await expect(harness.call('counter.increment', { counter: id })).resolves.toMatchObject({
      counter: { value: 3 },
    });
    await harness.stop();
  });
});
