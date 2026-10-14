import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, EmptyState, Spinner, useApi, usePlugins } from '@petalbot/ui-sdk';
import { loadOverlays, type OverlayToken } from '../app/endpoints.ts';
import { OwnerOnly } from '../app/OwnerOnly.tsx';
import { errorText } from '../plugins/actions.tsx';
import { overlaysKey } from './keys.ts';
import { NewOverlayDialog } from './NewOverlayDialog.tsx';
import { OverlayDetail } from './OverlayDetail.tsx';
import { OverlayList } from './OverlayList.tsx';
import { TokenDialog } from './TokenDialog.tsx';
import styles from './overlays.module.css';

interface ShownUrl {
  readonly title: string;
  readonly url: string;
}

export function OverlaysPage() {
  return (
    <OwnerOnly>
      <OverlaysContent />
    </OwnerOnly>
  );
}

function OverlaysContent() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { instanceId } = useParams({ strict: false });
  const plugins = usePlugins();
  // Declared overlays come from running plugins: refetch when that set changes.
  const running = [...plugins.values()]
    .filter((info) => info.state === 'running')
    .map((info) => info.id)
    .sort()
    .join(',');
  const query = useQuery({
    queryKey: [...overlaysKey, running],
    queryFn: () => loadOverlays(api),
  });
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<ShownUrl | null>(null);

  const created = (token: OverlayToken): void => {
    setCreating(false);
    setShown({ title: `${token.instance.name} is ready`, url: token.url });
    void queryClient.invalidateQueries({ queryKey: overlaysKey });
    void navigate({ to: '/admin/overlays/$instanceId', params: { instanceId: token.instance.id } });
  };

  let content: ReactNode;
  if (query.isPending) {
    content = <Spinner label="Loading overlays" />;
  } else if (query.isError) {
    content = (
      <EmptyState title="Overlays could not be loaded">{errorText(query.error)}</EmptyState>
    );
  } else if (query.data.instances.length === 0) {
    content = (
      <EmptyState title="No overlay instances">
        {query.data.overlays.length > 0
          ? 'Create one instance for each OBS browser source.'
          : 'No running plugin declares an overlay.'}
      </EmptyState>
    );
  } else {
    const selected = query.data.instances.find((instance) => instance.id === instanceId);
    let detail: ReactNode;
    if (selected) {
      detail = (
        <OverlayDetail
          key={selected.id}
          instance={selected}
          declared={query.data.overlays.find(
            (overlay) =>
              overlay.pluginId === selected.pluginId && overlay.overlay === selected.overlay,
          )}
          onUrl={(title, url) => {
            setShown({ title, url });
          }}
        />
      );
    } else if (instanceId !== undefined && query.isFetching) {
      detail = <Spinner label="Loading the instance" />;
    } else {
      detail = (
        <EmptyState
          title={instanceId === undefined ? 'Select an instance' : 'This instance no longer exists'}
        />
      );
    }
    content = (
      <div className={styles.layout}>
        <OverlayList instances={query.data.instances} selected={selected?.id} />
        <div className={styles.detail}>{detail}</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>Overlays</h1>
        <Button
          variant="primary"
          icon={Plus}
          disabled={!query.data || query.data.overlays.length === 0}
          onClick={() => {
            setCreating(true);
          }}
        >
          New instance
        </Button>
      </header>
      {content}
      {creating && query.data ? (
        <NewOverlayDialog
          overlays={query.data.overlays}
          onCancel={() => {
            setCreating(false);
          }}
          onCreated={created}
        />
      ) : null}
      {shown ? (
        <TokenDialog
          title={shown.title}
          url={shown.url}
          onClose={() => {
            setShown(null);
          }}
        />
      ) : null}
    </div>
  );
}
