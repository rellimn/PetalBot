import { act, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { describe, expect, it } from 'vitest';
import { usePlugin } from '../src/client/context.tsx';
import type { PluginInfo } from '../src/client/types.ts';
import { ownerUser } from './fake-socket.ts';
import { renderWithPetal } from './render.tsx';

const plugin = (id: string, state: PluginInfo['state'] = 'running'): PluginInfo => ({
  id,
  version: '1.0.0',
  dir: `/plugins/${id}`,
  state,
  enabled: state !== 'disabled',
  degraded: false,
  dependencies: [],
  optionalDependencies: [],
  hasPanel: false,
});

function Name({ id }: { readonly id: string }) {
  const info = usePlugin(id);
  return (
    <p>
      {id}: {info?.state ?? 'unknown'}
    </p>
  );
}

describe('usePlugin', () => {
  it('re-renders only when its own plugin changes', async () => {
    const renders = new Map<string, number>();
    const count = (id: string): void => {
      renders.set(id, (renders.get(id) ?? 0) + 1);
    };
    const { socket } = renderWithPetal(
      <>
        <Profiler id="quotes" onRender={count}>
          <Name id="quotes" />
        </Profiler>
        <Profiler id="chat" onRender={count}>
          <Name id="chat" />
        </Profiler>
      </>,
      ownerUser,
      {
        loadPlugins: () =>
          Promise.resolve({ plugins: [plugin('quotes'), plugin('chat')], problems: [] }),
      },
    );
    expect(await screen.findByText('quotes: running')).toBeTruthy();
    const quotesRenders = renders.get('quotes');
    act(() => {
      socket.receive({ type: 'plugin.state', plugin: plugin('chat', 'stopping') });
    });
    expect(screen.getByText('chat: stopping')).toBeTruthy();
    expect(renders.get('quotes')).toBe(quotesRenders);
  });
});
