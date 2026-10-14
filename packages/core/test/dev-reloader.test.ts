import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILD_MARKER,
  DevReloader,
  watchByPolling,
  type FileWatch,
  type ReloadablePlugin,
  type ReloadTarget,
} from '../src/dev-reloader.ts';
import { createMemoryLogger, type LogEntry } from './helpers.ts';

function fakeWatch() {
  const watched = new Map<string, () => void>();
  const watch: FileWatch = (file, onChange) => {
    watched.set(file, onChange);
    return () => {
      watched.delete(file);
    };
  };
  return {
    watch,
    watched,
    touch(dir: string) {
      watched.get(join(dir, BUILD_MARKER))?.();
    },
  };
}

function fakeManager(plugins: ReloadablePlugin[]) {
  const changes = new Set<(info: ReloadablePlugin) => void>();
  const removals = new Set<(id: string) => void>();
  const reloaded: string[] = [];
  const enabled: string[] = [];
  let failReload = false;
  const target: ReloadTarget = {
    list: () => plugins,
    reload: (id) => {
      reloaded.push(id);
      return failReload ? Promise.reject(new Error('setup threw')) : Promise.resolve();
    },
    enable: (id) => {
      enabled.push(id);
      return Promise.resolve();
    },
    onChange: (listener) => {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
    onRemoved: (listener) => {
      removals.add(listener);
      return () => {
        removals.delete(listener);
      };
    },
  };
  return {
    target,
    reloaded,
    enabled,
    failReloads() {
      failReload = true;
    },
    add(plugin: ReloadablePlugin) {
      plugins.push(plugin);
      for (const listener of changes) listener(plugin);
    },
    remove(id: string) {
      for (const listener of removals) listener(id);
    },
  };
}

const plugin = (
  id: string,
  state: ReloadablePlugin['state'] = 'running',
  enabled = true,
): ReloadablePlugin => ({ id, dir: `/srv/plugins/${id}`, state, enabled });

describe('DevReloader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reloads a running plugin once after its build marker changes', async () => {
    const files = fakeWatch();
    const manager = fakeManager([plugin('counter')]);
    const reloader = new DevReloader({
      manager: manager.target,
      logger: createMemoryLogger(),
      watch: files.watch,
    });
    reloader.start();
    expect([...files.watched.keys()]).toEqual([join('/srv/plugins/counter', BUILD_MARKER)]);
    files.touch('/srv/plugins/counter');
    await vi.advanceTimersByTimeAsync(100);
    files.touch('/srv/plugins/counter');
    expect(manager.reloaded).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(manager.reloaded).toEqual(['counter']);
    reloader.stop();
  });

  it('restarts enabled plugins that failed and leaves disabled ones alone', async () => {
    const files = fakeWatch();
    const manager = fakeManager([plugin('broken', 'failed'), plugin('off', 'disabled', false)]);
    const reloader = new DevReloader({
      manager: manager.target,
      logger: createMemoryLogger(),
      watch: files.watch,
    });
    reloader.start();
    files.touch('/srv/plugins/broken');
    files.touch('/srv/plugins/off');
    await vi.advanceTimersByTimeAsync(250);
    expect(manager.enabled).toEqual(['broken']);
    expect(manager.reloaded).toEqual([]);
    reloader.stop();
  });

  it('follows rescans and stops watching on stop', async () => {
    const files = fakeWatch();
    const manager = fakeManager([plugin('counter')]);
    const reloader = new DevReloader({
      manager: manager.target,
      logger: createMemoryLogger(),
      watch: files.watch,
    });
    reloader.start();
    manager.add(plugin('quotes'));
    expect(files.watched.size).toBe(2);
    manager.remove('counter');
    expect([...files.watched.keys()]).toEqual([join('/srv/plugins/quotes', BUILD_MARKER)]);
    files.touch('/srv/plugins/quotes');
    reloader.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(files.watched.size).toBe(0);
    expect(manager.reloaded).toEqual([]);
  });

  it('logs a failed reload instead of throwing', async () => {
    const files = fakeWatch();
    const manager = fakeManager([plugin('counter')]);
    manager.failReloads();
    const entries: LogEntry[] = [];
    const reloader = new DevReloader({
      manager: manager.target,
      logger: createMemoryLogger(entries),
      watch: files.watch,
    });
    reloader.start();
    files.touch('/srv/plugins/counter');
    await vi.advanceTimersByTimeAsync(250);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'Reloading a rebuilt plugin failed',
      }) as LogEntry,
    );
    reloader.stop();
  });
});

describe('watchByPolling', () => {
  it('reports when the file is written, also if it did not exist before', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'petalbot-watch-'));
    const file = join(dir, 'build.json');
    const changed = vi.fn();
    const stop = watchByPolling(file, changed);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(file, '{"builtAt":1}');
      await vi.waitFor(
        () => {
          expect(changed).toHaveBeenCalled();
        },
        { timeout: 3000, interval: 50 },
      );
    } finally {
      stop();
    }
  });
});

describe('DevReloader during transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not drop a rebuild that lands while the plugin is mid-transition', async () => {
    const plugins = [plugin('counter', 'starting'), plugin('fan', 'disabled', true)];
    const manager = fakeManager(plugins);
    const files = fakeWatch();
    const reloader = new DevReloader({
      manager: manager.target,
      logger: createMemoryLogger(),
      watch: files.watch,
    });
    reloader.start();
    files.touch('/srv/plugins/counter');
    files.touch('/srv/plugins/fan');
    await vi.advanceTimersByTimeAsync(200);
    expect(manager.reloaded).toEqual([]);
    plugins[0] = plugin('counter', 'running');
    plugins[1] = plugin('fan', 'running');
    await vi.advanceTimersByTimeAsync(200);
    expect(manager.reloaded.sort()).toEqual(['counter', 'fan']);
    reloader.stop();
  });

  it('reloads once more when a rebuild lands during a reload', async () => {
    const manager = fakeManager([plugin('counter')]);
    let finish: () => void = () => undefined;
    manager.target.reload = (id) => {
      manager.reloaded.push(id);
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const files = fakeWatch();
    const reloader = new DevReloader({
      manager: manager.target,
      logger: createMemoryLogger(),
      watch: files.watch,
    });
    reloader.start();
    files.touch('/srv/plugins/counter');
    await vi.advanceTimersByTimeAsync(200);
    files.touch('/srv/plugins/counter');
    await vi.advanceTimersByTimeAsync(200);
    expect(manager.reloaded).toEqual(['counter']);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.reloaded).toEqual(['counter', 'counter']);
    finish();
    reloader.stop();
  });
});
