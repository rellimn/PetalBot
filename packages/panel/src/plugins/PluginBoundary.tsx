import { Component, Fragment, type ReactNode } from 'react';
import { Button, Card } from '@petalbot/ui-sdk';

interface BoundaryProps {
  readonly pluginId: string;
  /** What crashed, e.g. the page or widget title. */
  readonly label: string;
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly error: Error | undefined;
  readonly attempt: number;
}

/** Keeps a crashing plugin page or widget from taking the panel down. */
export class PluginBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: undefined, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown): void {
    console.error(`PetalBot: ${this.props.pluginId} crashed`, error);
  }

  override render(): ReactNode {
    const { error, attempt } = this.state;
    if (error) {
      return (
        <Card title={`${this.props.label} crashed`}>
          <p>
            {this.props.pluginId}: {error.message}
          </p>
          <div>
            <Button
              onClick={() => {
                this.setState((state) => ({ error: undefined, attempt: state.attempt + 1 }));
              }}
            >
              Reload
            </Button>
          </div>
        </Card>
      );
    }
    return <Fragment key={attempt}>{this.props.children}</Fragment>;
  }
}
