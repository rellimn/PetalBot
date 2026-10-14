import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@petalbot/sdk';
import { EventLog } from '../../src/server/event-log.ts';
import { openDatabase } from '../../src/storage/database.ts';

const envelope = (n: number, payload: unknown = { n }): EventEnvelope => ({
  id: `0${String(n).padStart(3, '0')}`,
  name: 'chat.message',
  payload,
  source: 'chat',
  timestamp: 1000 + n,
  depth: n === 2 ? 1 : 0,
  ...(n === 2 ? { causedBy: '0001' } : {}),
});

describe('EventLog', () => {
  it('lists recorded events newest first, paged by id', () => {
    const log = new EventLog(openDatabase(':memory:'));
    for (let n = 1; n <= 5; n++) log.record(envelope(n));
    expect(log.list({ limit: 2 }).map((e) => e.id)).toEqual(['0005', '0004']);
    expect(log.list({ before: '0004', limit: 2 }).map((e) => e.id)).toEqual(['0003', '0002']);
    expect(log.list({ before: '0003', limit: 5 })[0]).toEqual(envelope(2));
  });

  it('keeps at most `capacity` events', () => {
    const log = new EventLog(openDatabase(':memory:'), { capacity: 3, trimEvery: 1 });
    for (let n = 1; n <= 5; n++) log.record(envelope(n));
    expect(log.list({ limit: 10 }).map((e) => e.id)).toEqual(['0005', '0004', '0003']);
  });

  it('survives a restart and trims to a smaller capacity at startup', () => {
    const sqlite = openDatabase(':memory:');
    const first = new EventLog(sqlite);
    for (let n = 1; n <= 4; n++) first.record(envelope(n));
    const second = new EventLog(sqlite, { capacity: 2 });
    expect(second.list({ limit: 10 }).map((e) => e.id)).toEqual(['0004', '0003']);
  });

  it('stores payloads that cannot be serialized as a marker', () => {
    const log = new EventLog(openDatabase(':memory:'));
    log.record(envelope(1, { big: 1n }));
    expect(log.list({ limit: 1 })[0]?.payload).toBe('[unserializable payload]');
  });
});
