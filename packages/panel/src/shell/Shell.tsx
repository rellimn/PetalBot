import { Outlet, useLocation, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useConnectionStatus } from '@petalbot/ui-sdk';
import { FocusContext } from './focus.ts';
import { ReconnectBanner } from './ReconnectBanner.tsx';
import { SessionNotice } from './SessionNotice.tsx';
import styles from './Shell.module.css';
import { Sidebar } from './Sidebar.tsx';
import { TopBar } from './TopBar.tsx';

export function Shell() {
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const status = useConnectionStatus();
  const [focusRequested, setFocused] = useState(false);
  const [drawer, setDrawer] = useState(false);
  // Focus belongs to the dashboard and is never restored: any navigation ends it.
  const focused = focusRequested && pathname === '/';

  useEffect(
    () =>
      router.subscribe('onBeforeNavigate', () => {
        setFocused(false);
        setDrawer(false);
      }),
    [router],
  );

  useEffect(() => {
    if (!focused) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFocused(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [focused]);

  return (
    <FocusContext value={{ focused, setFocused }}>
      <div className={styles.shell} data-focus={focused || undefined}>
        {focused ? null : (
          <TopBar
            onMenu={() => {
              setDrawer((open) => !open);
            }}
          />
        )}
        {focused ? null : <Sidebar open={drawer} />}
        {drawer && !focused ? (
          <button
            type="button"
            className={styles.backdrop}
            aria-label="Close menu"
            onClick={() => {
              setDrawer(false);
            }}
          />
        ) : null}
        <main className={styles.main}>
          {focused ? null : <ReconnectBanner />}
          <SessionNotice />
          <div className={styles.content} data-stale={status === 'reconnecting' || undefined}>
            <Outlet />
          </div>
        </main>
      </div>
    </FocusContext>
  );
}
