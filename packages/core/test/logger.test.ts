import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.ts';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = {
    write: (line: string) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  return { lines, destination };
}

describe('createLogger', () => {
  it('writes JSON lines with message, data and child bindings', () => {
    const { lines, destination } = capture();
    createLogger({ destination }).child({ plugin: 'quotes' }).info('hello', { n: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 30, msg: 'hello', plugin: 'quotes', n: 1 });
  });

  it('drops messages below the level', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ destination, level: 'warn' });
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(lines.map((line) => line.msg)).toEqual(['c', 'd']);
  });

  it('hands entries at or above the level to the sink, with child bindings', () => {
    const { destination } = capture();
    const records: unknown[] = [];
    const logger = createLogger({
      destination,
      level: 'info',
      sink: (record) => records.push(record),
    });
    logger.debug('hidden');
    logger.child({ plugin: 'quotes' }).warn('careful', { n: 2 });
    expect(records).toEqual([
      {
        time: expect.any(Number) as number,
        level: 'warn',
        message: 'careful',
        data: { plugin: 'quotes', n: 2 },
      },
    ]);
  });

  it('keeps logging when the sink throws', () => {
    const { lines, destination } = capture();
    const logger = createLogger({
      destination,
      sink: () => {
        throw new Error('sink bug');
      },
    });
    logger.info('still written');
    expect(lines.map((line) => line.msg)).toEqual(['still written']);
  });
});
