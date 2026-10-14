import { Link } from '@tanstack/react-router';
import { Popover, StatusDot, useConnectionStatus, usePlugins, useUser } from '@petalbot/ui-sdk';
import { healthOf } from './navigation.ts';
import styles from './TopBar.module.css';

/** Plugin health at a glance; in focus mode (`showConnection`) it also turns amber offline. */
export function HealthDot({ showConnection = false }: { readonly showConnection?: boolean }) {
  const plugins = usePlugins();
  const status = useConnectionStatus();
  const user = useUser();
  const health = healthOf(plugins);
  const offline = showConnection && status !== 'open';
  const count = health.problems.length;
  const label = offline
    ? 'Reconnecting…'
    : count === 0
      ? 'All plugins are fine'
      : `${String(count)} plugin${count === 1 ? ' needs' : 's need'} attention`;
  return (
    <Popover
      label="Plugin health"
      trigger={
        <button type="button" className={styles.health} aria-label={label}>
          <StatusDot
            key={health.problems.map((plugin) => plugin.id).join(',')}
            tone={offline ? 'warning' : health.tone}
            label={label}
            pulse={!offline && health.tone === 'danger'}
          />
        </button>
      }
    >
      {count === 0 ? (
        <p className={styles.popoverText}>All plugins are fine.</p>
      ) : (
        <ul className={styles.problems}>
          {health.problems.map((plugin) => (
            <li key={plugin.id}>
              {plugin.id}:{' '}
              {plugin.state === 'failed'
                ? (plugin.error ?? 'failed')
                : 'degraded (many errors recently)'}
            </li>
          ))}
        </ul>
      )}
      {user.role === 'owner' ? <Link to="/admin/plugins">Open plugins</Link> : null}
    </Popover>
  );
}
