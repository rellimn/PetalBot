import { pino, type Logger as PinoLogger } from 'pino';
import type { LogData, Logger } from '@petalbot/sdk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One written entry, as the logger hands it to its sink. */
export interface LogRecord {
  readonly time: number;
  readonly level: LogLevel;
  readonly message: string;
  /** Child bindings merged with the call's data. */
  readonly data: LogData;
}

export interface LoggerOptions {
  /** Default 'info'. */
  readonly level?: LogLevel;
  /** Default stdout. */
  readonly destination?: { write(line: string): void };
  /** Also receives every entry at or above the level (the panel's log ring). Its errors are ignored. */
  readonly sink?: (record: LogRecord) => void;
}

/** JSON-lines logger implementing the SDK `Logger` interface. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const settings = { level: options.level ?? 'info' };
  const base = options.destination ? pino(settings, options.destination) : pino(settings);
  return wrap(base, options.sink, {});
}

function wrap(base: PinoLogger, sink: LoggerOptions['sink'], bindings: LogData): Logger {
  const write =
    (level: LogLevel) =>
    (message: string, data?: LogData): void => {
      base[level](data ?? {}, message);
      if (sink === undefined || !base.isLevelEnabled(level)) return;
      try {
        sink({ time: Date.now(), level, message, data: { ...bindings, ...data } });
      } catch {
        // A failing sink must never break logging.
      }
    };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (more) => wrap(base.child(more), sink, { ...bindings, ...more }),
  };
}
