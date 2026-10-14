import { createContext, useContext, type ReactNode } from 'react';
import type { PanelUser } from '@petalbot/sdk';
import { useStore } from '../store.ts';
import type { ConnectionStatus, PetalConnection } from './connection.ts';
import type { Api } from './http.ts';
import type { PluginInfo } from './types.ts';

export interface PetalContextValue {
  readonly connection: PetalConnection;
  readonly api: Api;
  readonly user: PanelUser;
}

const PetalContext = createContext<PetalContextValue | null>(null);
/** Separate from PetalContext: overlay pages have a connection but no session, API or user. */
const ConnectionContext = createContext<PetalConnection | null>(null);

let registered: PetalConnection | undefined;

/** Makes `connection` the one `client.call(...)` uses outside components. Call once per page. */
export function registerConnection(connection: PetalConnection): void {
  registered = connection;
}

export function currentConnection(): PetalConnection {
  if (!registered) throw new Error('PetalBot: no connection is registered yet');
  return registered;
}

/** The panel's provider: connection, API and the logged-in user. */
export function PetalProvider({
  value,
  children,
}: {
  readonly value: PetalContextValue;
  readonly children: ReactNode;
}) {
  return (
    <ConnectionContext value={value.connection}>
      <PetalContext value={value}>{children}</PetalContext>
    </ConnectionContext>
  );
}

/** Only the connection, for pages without a panel session (the overlay host). */
export function ConnectionProvider({
  connection,
  children,
}: {
  readonly connection: PetalConnection;
  readonly children: ReactNode;
}) {
  return <ConnectionContext value={connection}>{children}</ConnectionContext>;
}

export function usePetal(): PetalContextValue {
  const value = useContext(PetalContext);
  if (!value) throw new Error('PetalBot: render this inside <PetalProvider>');
  return value;
}

export function useConnection(): PetalConnection {
  const connection = useContext(ConnectionContext);
  if (!connection) {
    throw new Error('PetalBot: render this inside <PetalProvider> or <ConnectionProvider>');
  }
  return connection;
}

export function useApi(): Api {
  return usePetal().api;
}

export function useUser(): PanelUser {
  return usePetal().user;
}

export function useConnectionStatus(): ConnectionStatus {
  const connection = useConnection();
  return useStore(connection.state, (state) => state.status);
}

/** Every known plugin, live. */
export function usePlugins(): ReadonlyMap<string, PluginInfo> {
  const connection = useConnection();
  return useStore(connection.state, (state) => state.plugins);
}

/** One plugin, live; re-renders only when this plugin changes. */
export function usePlugin(pluginId: string): PluginInfo | undefined {
  const connection = useConnection();
  return useStore(connection.state, (state) => state.plugins.get(pluginId));
}

/** Whether the plugin list has arrived (until then an empty list means "unknown"). */
export function usePluginsLoaded(): boolean {
  const connection = useConnection();
  return useStore(connection.state, (state) => state.pluginsLoaded);
}
