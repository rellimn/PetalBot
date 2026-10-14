import { describe, expect, it } from 'vitest';
import { LogRing, MAX_LOG_DATA_CHARS } from '../src/log-ring.ts';
import type { LogRecord } from '../src/logger.ts';

const record = (message: string, extra: Partial<LogRecord> = {}): LogRecord => ({
  time: 1000,
  level: 'info',
  message,
  data: {},
  ...extra,
});

describe('LogRing', () => {
  it('assigns increasing ids and keeps only the newest entries', () => {
    const ring = new LogRing({ capacity: 3 });
    for (const message of ['a', 'b', 'c', 'd']) ring.push(record(message));
    expect(ring.list({ limit: 10 }).map((entry) => [entry.id, entry.message])).toEqual([
      [4, 'd'],
      [3, 'c'],
      [2, 'b'],
    ]);
  });

  it('takes the plugin from the data and filters by plugin, level and id', () => {
    const ring = new LogRing();
    ring.push(record('core info'));
    ring.push(record('quotes debug', { level: 'debug', data: { plugin: 'quotes', n: 1 } }));
    ring.push(record('quotes warn', { level: 'warn', data: { plugin: 'quotes' } }));
    ring.push(record('chat error', { level: 'error', data: { plugin: 'chat' } }));
    const quotes = ring.list({ plugin: 'quotes', limit: 10 });
    expect(quotes.map((entry) => entry.message)).toEqual(['quotes warn', 'quotes debug']);
    expect(quotes[1]).toMatchObject({ plugin: 'quotes', data: { n: 1 } });
    expect(quotes[1]?.data).not.toHaveProperty('plugin');
    expect(ring.list({ plugin: 'core', limit: 10 }).map((e) => e.message)).toEqual(['core info']);
    expect(ring.list({ level: 'warn', limit: 10 }).map((e) => e.message)).toEqual([
      'chat error',
      'quotes warn',
    ]);
    expect(ring.list({ before: 3, limit: 1 }).map((e) => e.message)).toEqual(['quotes debug']);
  });

  it('makes data JSON-safe and truncates large data', () => {
    const ring = new LogRing();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(ring.push(record('e', { data: { error: new TypeError('nope') } })).data).toEqual({
      error: { name: 'TypeError', message: 'nope' },
    });
    expect(ring.push(record('b', { data: { big: 10n } })).data).toEqual({ big: '10' });
    expect(ring.push(record('c', { data: { circular } })).data).toEqual({ unserializable: true });
    const big = ring.push(record('t', { data: { text: 'x'.repeat(MAX_LOG_DATA_CHARS) } })).data;
    expect(typeof big.truncated).toBe('string');
    expect(String(big.truncated)).toHaveLength(MAX_LOG_DATA_CHARS);
  });

  it('notifies listeners and survives a throwing one', () => {
    const ring = new LogRing();
    const seen: string[] = [];
    ring.onEntry(() => {
      throw new Error('listener bug');
    });
    const off = ring.onEntry((entry) => seen.push(entry.message));
    ring.push(record('one'));
    off();
    ring.push(record('two'));
    expect(seen).toEqual(['one']);
  });
});
