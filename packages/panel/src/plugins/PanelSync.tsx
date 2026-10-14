import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useConnectionStatus, usePlugins, type PluginInfo } from '@petalbot/ui-sdk';
import { useRegistry } from '../app/context.ts';

/**
 * Keeps plugin bundles in step with plugin states, and refreshes plugin data after a reconnect
 * or when a plugin runs again (its data may have changed meanwhile).
 */
export function PanelSync() {
  const registry = useRegistry();
  const plugins = usePlugins();
  const status = useConnectionStatus();
  const queryClient = useQueryClient();
  const previous = useRef<ReadonlyMap<string, PluginInfo>>(new Map());

  useEffect(() => {
    registry.sync(plugins);
    for (const info of plugins.values()) {
      const before = previous.current.get(info.id);
      if (info.state === 'running' && before !== undefined && before.state !== 'running') {
        void queryClient.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === 'petalbot' &&
            query.queryKey[1] === 'rpc' &&
            String(query.queryKey[2]).startsWith(`${info.id}.`),
        });
      }
    }
    previous.current = plugins;
  }, [registry, plugins, queryClient]);

  useEffect(() => {
    // cancelRefetch: false, so this and the live queries' own reconnect refetch share one request.
    if (status === 'open') {
      void queryClient.invalidateQueries(
        { queryKey: ['petalbot', 'rpc'] },
        { cancelRefetch: false },
      );
    }
  }, [status, queryClient]);

  return null;
}
