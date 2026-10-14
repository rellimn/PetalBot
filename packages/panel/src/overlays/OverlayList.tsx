import { Link } from '@tanstack/react-router';
import { StatusDot, usePlugins } from '@petalbot/ui-sdk';
import type { OverlayInstance } from '../app/endpoints.ts';
import styles from './overlays.module.css';

/** Instances grouped by `plugin > overlay`, in creation order within a group. */
function groupsOf(instances: readonly OverlayInstance[]): [string, OverlayInstance[]][] {
  const groups = new Map<string, OverlayInstance[]>();
  for (const instance of instances) {
    const label = `${instance.pluginId} > ${instance.overlay}`;
    groups.set(label, [...(groups.get(label) ?? []), instance]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

export function OverlayList({
  instances,
  selected,
}: {
  readonly instances: readonly OverlayInstance[];
  readonly selected: string | undefined;
}) {
  const plugins = usePlugins();
  return (
    <nav aria-label="Overlay instances" className={styles.list}>
      {groupsOf(instances).map(([label, items]) => (
        <section key={label} aria-label={label} className={styles.group}>
          <h2 className={styles.groupLabel}>{label}</h2>
          <ul className={styles.items}>
            {items.map((instance) => {
              const running = plugins.get(instance.pluginId)?.state === 'running';
              return (
                <li key={instance.id}>
                  <Link
                    to="/admin/overlays/$instanceId"
                    params={{ instanceId: instance.id }}
                    className={styles.item}
                    aria-current={instance.id === selected ? 'page' : undefined}
                  >
                    <span>{instance.name}</span>
                    <StatusDot
                      tone={running ? 'ok' : 'idle'}
                      label={
                        running
                          ? `${instance.pluginId} is running`
                          : `${instance.pluginId} is not running`
                      }
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}
