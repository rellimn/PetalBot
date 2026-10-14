import { z } from 'zod';
import { defineContract, type LogData, type Logger } from '@petalbot/sdk';

export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly data: LogData;
}

export interface MemoryLogger extends Logger {
  readonly entries: LogEntry[];
}

/** Logger that records entries (shared with its children) for assertions. */
export function createMemoryLogger(entries: LogEntry[] = [], bindings: LogData = {}): MemoryLogger {
  const write =
    (level: LogEntry['level']) =>
    (message: string, data: LogData = {}): void => {
      entries.push({ level, message, data: { ...bindings, ...data } });
    };
  return {
    entries,
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (more) => createMemoryLogger(entries, { ...bindings, ...more }),
  };
}

export const counterContract = defineContract({
  id: 'counter',
  version: '1.0.0',
  events: {
    ticked: { schema: z.object({ n: z.number().int() }) },
  },
  hooks: {
    beforeTick: { input: z.object({ n: z.number().int() }) },
    strictCheck: { input: z.object({ n: z.number().int() }), failClosed: true },
  },
  rpc: {
    double: { input: z.object({ n: z.number() }), output: z.number() },
  },
  providers: {
    sink: {
      write: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) },
      flush: { input: z.object({}), output: z.object({}) },
    },
  },
});

export const listenerContract = defineContract({
  id: 'listener',
  version: '1.0.0',
  events: {
    heard: { schema: z.object({ n: z.number() }) },
  },
});

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
