import { Button, EmptyState, useUser, type PluginInfo } from '@petalbot/ui-sdk';
import { usePluginActions } from './actions.tsx';

export function NotRunning({ info }: { readonly info: PluginInfo }) {
  const user = useUser();
  const actions = usePluginActions();
  const canEnable = user.role === 'owner' && info.state !== 'starting' && info.state !== 'stopping';
  return (
    <>
      <EmptyState
        title={`${info.id} is not running`}
        action={
          canEnable ? (
            <Button
              variant="primary"
              loading={actions.busy === info.id}
              onClick={() => {
                void actions.run('enable', info.id);
              }}
            >
              Enable
            </Button>
          ) : undefined
        }
      >
        {info.state === 'failed' && info.error !== undefined
          ? info.error
          : 'This page comes back by itself when the plugin runs again.'}
      </EmptyState>
      {actions.dialog}
    </>
  );
}
