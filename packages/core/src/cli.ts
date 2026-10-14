import { errorMessage } from './names.ts';
import { startPetalBot } from './server/main.ts';

const SHUTDOWN_DEADLINE_MS = 15_000;

try {
  const bot = await startPetalBot({
    configPath: process.env.PETALBOT_CONFIG ?? 'petalbot.config.ts',
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => {
      process.stderr.write('PetalBot did not shut down within 15 s, exiting\n');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS).unref();
    bot.close().then(
      () => {
        process.exit(0);
      },
      (error: unknown) => {
        process.stderr.write(`PetalBot shutdown failed: ${errorMessage(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  process.stderr.write(`PetalBot failed to start: ${errorMessage(error)}\n`);
  process.exit(1);
}
