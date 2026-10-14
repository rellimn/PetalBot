import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { Component, type ReactNode } from 'react';
import { ConnectionProvider, useStore, type PetalConnection } from '@petalbot/ui-sdk';
import type { OverlayRuntime } from './runtime.ts';

export interface OverlayHostProps {
  readonly connection: PetalConnection;
  readonly runtime: OverlayRuntime;
  readonly queryClient: QueryClient;
}

/** Renders the overlay on a transparent page, or nothing. Never an error message on stream. */
export function OverlayHost({ connection, runtime, queryClient }: OverlayHostProps) {
  const session = useStore(connection.state, (state) => state.overlay);
  const view = useStore(runtime.state, (state) => state.view);
  // 'ended': the token was revoked or rotated. Stale data must not stay on stream.
  const ended = useStore(connection.state, (state) => state.status === 'ended');
  if (ended || session === undefined || view.status !== 'ready') return null;
  const { definition } = view;
  const parsed = definition.config.safeParse(session.config);
  if (!parsed.success) {
    console.error(
      `PetalBot: the config of this instance does not fit ${definition.pluginId}/${definition.name}; change it in Admin › Overlays`,
      parsed.error.issues,
    );
    return null;
  }
  const Overlay = definition.component;
  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider connection={connection}>
        <OverlayBoundary name={`${definition.pluginId}/${definition.name}`}>
          <Overlay config={parsed.data} />
        </OverlayBoundary>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}

interface BoundaryProps {
  readonly name: string;
  readonly children: ReactNode;
}

/** A crashing overlay renders nothing (until the page reloads) instead of an error on stream. */
class OverlayBoundary extends Component<BoundaryProps, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error(`PetalBot: the overlay ${this.props.name} crashed`, error);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
