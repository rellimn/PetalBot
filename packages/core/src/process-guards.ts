import type { Logger } from '@petalbot/sdk';
import { errorMessage } from './names.ts';

export interface ProcessGuardOptions {
  readonly kernel: { reportUncaught(error: unknown): boolean };
  readonly logger: Logger;
  /** Default `process.exit`. */
  readonly exit?: (code: number) => void;
}

/** Plugin errors are attributed and survived; errors from core code end the process. */
export function createUncaughtHandler(options: ProcessGuardOptions): (error: unknown) => void {
  const exit =
    options.exit ??
    ((code: number) => {
      process.exit(code);
    });
  return (error) => {
    if (options.kernel.reportUncaught(error)) return;
    options.logger.error('Uncaught error in core, exiting', { error: errorMessage(error) });
    exit(1);
  };
}

/** Installs the handler for uncaught exceptions and unhandled rejections; returns an uninstaller. */
export function installProcessGuards(options: ProcessGuardOptions): () => void {
  const handler = createUncaughtHandler(options);
  process.on('uncaughtException', handler);
  process.on('unhandledRejection', handler);
  return () => {
    process.off('uncaughtException', handler);
    process.off('unhandledRejection', handler);
  };
}
