import { Cron } from 'croner';
import type { ScheduleApi, ScheduledTask } from '@petalbot/sdk';
import { outsideActor } from './actor-scope.ts';
import { once } from './disposer-scope.ts';
import { runInPlugin } from './plugin-scope.ts';

export interface SchedulerOptions {
  readonly pluginId: string;
  /** Receives errors of failed runs (inside the plugin's scope). */
  readonly onError: (error: unknown) => void;
}

export function createScheduler(options: SchedulerOptions): ScheduleApi {
  // A timer armed during a call must not act for that call's actor forever: tasks run as the
  // plugin itself.
  const invoke = (task: ScheduledTask): Promise<void> =>
    outsideActor(() =>
      runInPlugin(options.pluginId, async () => {
        try {
          await task();
        } catch (error) {
          options.onError(error);
        }
      }),
    );

  /** Skips a tick while the previous run of the same job is still in progress. */
  const exclusive = (task: ScheduledTask) => {
    let running = false;
    return () => {
      if (running) return;
      running = true;
      void invoke(task).finally(() => {
        running = false;
      });
    };
  };

  return {
    after(ms, task) {
      const timer = setTimeout(() => void invoke(task), ms);
      timer.unref();
      return once(() => {
        clearTimeout(timer);
      });
    },
    every(ms, task) {
      const timer = setInterval(exclusive(task), ms);
      timer.unref();
      return once(() => {
        clearInterval(timer);
      });
    },
    cron(expression, task) {
      const job = new Cron(expression, exclusive(task));
      return once(() => {
        job.stop();
      });
    },
  };
}
