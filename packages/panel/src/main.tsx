import '@petalbot/ui-sdk/theme.css';
import './global.css';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ApiError,
  PetalConnection,
  createApi,
  registerConnection,
  type Me,
} from '@petalbot/ui-sdk';
import { App } from './app/App.tsx';
import { loadMe, loadPlugins } from './app/endpoints.ts';
import { createSession } from './app/session.ts';
import { loginUrl, socketUrl } from './app/urls.ts';
import { LoginErrorPage } from './pages/LoginErrorPage.tsx';
import { StartupError } from './pages/StartupError.tsx';

async function bootstrap(root: Root): Promise<void> {
  if (location.pathname === '/login-error') {
    root.render(<LoginErrorPage reason={new URLSearchParams(location.search).get('reason')} />);
    return;
  }
  const session = createSession();
  const api = createApi({
    onUnauthorized: () => {
      session.end();
    },
  });
  let me: Me;
  try {
    me = await loadMe(api);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      location.assign(loginUrl(`${location.pathname}${location.search}${location.hash}`));
      return;
    }
    root.render(
      <StartupError
        onRetry={() => {
          void bootstrap(root);
        }}
      />,
    );
    return;
  }
  const connection = new PetalConnection({
    url: socketUrl(location),
    loadPlugins: () => loadPlugins(api),
    probe: async () => {
      try {
        await loadMe(api);
        return 'retry';
      } catch (error) {
        return error instanceof ApiError && error.status === 401 ? 'ended' : 'retry';
      }
    },
  });
  registerConnection(connection);
  connection.start();
  root.render(
    <StrictMode>
      <App me={me} api={api} connection={connection} session={session} />
    </StrictMode>,
  );
}

const element = document.getElementById('root');
if (element) void bootstrap(createRoot(element));
