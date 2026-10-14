import '@petalbot/ui-sdk/theme.css';
import './global.css';
import { QueryClient } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PetalConnection, registerConnection } from '@petalbot/ui-sdk';
import { overlaySocketUrl, parseOverlayAddress } from './location.ts';
import { OverlayHost } from './OverlayHost.tsx';
import { OverlayRuntime } from './runtime.ts';

const address = parseOverlayAddress(location);
const element = document.getElementById('root');
if (!address) {
  console.error('PetalBot: this overlay URL is incomplete; copy it again from Admin › Overlays');
} else if (element) {
  const connection = new PetalConnection({ url: overlaySocketUrl(location, address) });
  registerConnection(connection);
  connection.state.subscribe((state) => {
    if (state.status === 'ended') {
      console.warn('PetalBot: this overlay URL no longer works (revoked or rotated token)');
    }
  });
  const runtime = new OverlayRuntime({ pluginId: address.pluginId, overlay: address.overlay });
  runtime.follow(connection);
  connection.start();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  createRoot(element).render(
    <StrictMode>
      <OverlayHost connection={connection} runtime={runtime} queryClient={queryClient} />
    </StrictMode>,
  );
}
