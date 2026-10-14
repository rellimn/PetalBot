import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useState } from 'react';
import { PetalProvider, Toaster, type Api, type Me, type PetalConnection } from '@petalbot/ui-sdk';
import { PanelSync } from '../plugins/PanelSync.tsx';
import { PanelRegistry } from '../plugins/registry.ts';
import { Appearance } from './appearance.tsx';
import { AppContext } from './context.ts';
import { createQueryClient } from './query-client.ts';
import { createAppRouter } from './router.tsx';
import { SessionSync } from './SessionSync.tsx';
import type { Session } from './session.ts';

export interface AppProps {
  readonly me: Me;
  readonly api: Api;
  readonly connection: PetalConnection;
  readonly session: Session;
  readonly registry?: PanelRegistry;
  readonly history?: RouterHistory;
  readonly queryClient?: QueryClient;
  readonly leave?: (url: string) => void;
}

const defaultLeave = (url: string): void => {
  window.location.assign(url);
};

export function App({
  me,
  api,
  connection,
  session,
  registry,
  history,
  queryClient,
  leave,
}: AppProps) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  const [panels] = useState(() => registry ?? new PanelRegistry());
  const [router] = useState(() => createAppRouter(history));
  return (
    <QueryClientProvider client={client}>
      <PetalProvider value={{ connection, api, user: me.user }}>
        <AppContext
          value={{ registry: panels, session, devAuth: me.devAuth, leave: leave ?? defaultLeave }}
        >
          <Toaster>
            <Appearance />
            <PanelSync />
            <SessionSync />
            <RouterProvider router={router} />
          </Toaster>
        </AppContext>
      </PetalProvider>
    </QueryClientProvider>
  );
}
