import { Link } from '@tanstack/react-router';
import { Menu as MenuIcon } from 'lucide-react';
import { Badge, IconButton } from '@petalbot/ui-sdk';
import { useDevAuth } from '../app/context.ts';
import { HealthDot } from './HealthDot.tsx';
import styles from './TopBar.module.css';
import { UserMenu } from './UserMenu.tsx';

export function TopBar({ onMenu }: { readonly onMenu: () => void }) {
  const devAuth = useDevAuth();
  return (
    <header className={styles.topbar}>
      <IconButton className={styles.menuButton} label="Menu" icon={MenuIcon} onClick={onMenu} />
      <Link to="/" className={styles.logo}>
        ✿ PetalBot
      </Link>
      <span className={styles.spacer} />
      {devAuth ? <Badge tone="warning">dev login</Badge> : null}
      <HealthDot />
      <UserMenu />
    </header>
  );
}
