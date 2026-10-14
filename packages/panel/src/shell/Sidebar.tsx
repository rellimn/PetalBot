import { Link } from '@tanstack/react-router';
import { LayoutDashboard, ScrollText, Activity, Layers, Puzzle } from 'lucide-react';
import { usePlugins, useUser } from '@petalbot/ui-sdk';
import { useKnownPanels } from '../plugins/registry.ts';
import { buildPluginNav, type NavLink } from './navigation.ts';
import styles from './Sidebar.module.css';

function NavItem({ item }: { readonly item: NavLink }) {
  const Icon = item.icon;
  const content = (
    <>
      {Icon ? <Icon size={16} aria-hidden /> : null}
      {item.label}
    </>
  );
  const props = { className: styles.link, 'data-disabled': item.disabled || undefined };
  return item.target.to === '/settings/$pluginId' ? (
    <Link {...props} to="/settings/$pluginId" params={{ pluginId: item.target.params.pluginId }}>
      {content}
    </Link>
  ) : (
    <Link
      {...props}
      to="/p/$pluginId/$"
      params={{ pluginId: item.target.params.pluginId, _splat: item.target.params._splat }}
    >
      {content}
    </Link>
  );
}

export function Sidebar({ open }: { readonly open: boolean }) {
  const user = useUser();
  const plugins = usePlugins();
  const known = useKnownPanels();
  const entries = buildPluginNav(plugins, known, user.role);
  return (
    <nav aria-label="Main" className={styles.sidebar} data-open={open || undefined}>
      <Link to="/" className={styles.link} activeOptions={{ exact: true }}>
        <LayoutDashboard size={16} aria-hidden />
        Dashboard
      </Link>
      {entries.length > 0 ? <p className={styles.section}>Plugins</p> : null}
      {entries.map((entry) =>
        entry.kind === 'link' ? (
          <NavItem key={entry.key} item={entry} />
        ) : (
          <details
            key={entry.id}
            className={styles.group}
            data-disabled={entry.disabled || undefined}
            open
          >
            <summary className={styles.summary}>{entry.label}</summary>
            {entry.items.map((item) => (
              <NavItem key={item.key} item={item} />
            ))}
          </details>
        ),
      )}
      {user.role === 'owner' ? (
        <>
          <p className={styles.section}>Admin</p>
          <Link to="/admin/plugins" className={styles.link}>
            <Puzzle size={16} aria-hidden />
            Plugins
          </Link>
          <Link to="/admin/overlays" className={styles.link}>
            <Layers size={16} aria-hidden />
            Overlays
          </Link>
          <Link to="/admin/logs" className={styles.link}>
            <ScrollText size={16} aria-hidden />
            Logs
          </Link>
          <Link to="/admin/events" className={styles.link}>
            <Activity size={16} aria-hidden />
            Events
          </Link>
        </>
      ) : null}
    </nav>
  );
}
