import { useState } from 'react';
import { Banner, Button, useApi, useConnection, useToast } from '@petalbot/ui-sdk';
import { useSession } from '../app/context.ts';
import { loadMe } from '../app/endpoints.ts';
import { useSessionEnded } from '../app/session.ts';
import { loginUrl } from '../app/urls.ts';
import styles from './Shell.module.css';

/** The session ended while the panel was open. Nothing navigates away: typed input stays. */
export function SessionNotice() {
  const ended = useSessionEnded();
  const session = useSession();
  const api = useApi();
  const connection = useConnection();
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  if (!ended) return null;

  const check = async (): Promise<void> => {
    setChecking(true);
    try {
      await loadMe(api);
      session.resume();
      connection.restart();
    } catch {
      toast({
        title: 'Still logged out',
        description: 'Log in in the new tab first.',
        tone: 'warning',
      });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Banner
      tone="danger"
      action={
        <div className={styles.noticeActions}>
          <Button
            onClick={() => {
              window.open(loginUrl('/'), '_blank', 'noopener');
            }}
          >
            Log in (new tab)
          </Button>
          <Button
            variant="primary"
            loading={checking}
            onClick={() => {
              void check();
            }}
          >
            I&apos;m logged in again
          </Button>
        </div>
      }
    >
      Your session ended. Log in again in a new tab; this page keeps what you typed.
    </Banner>
  );
}
