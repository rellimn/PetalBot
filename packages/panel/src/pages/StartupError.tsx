import { Button } from '@petalbot/ui-sdk';
import styles from './pages.module.css';

export function StartupError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <main className={styles.standalone}>
      <div className={styles.box}>
        <p className={styles.logo}>✿ PetalBot</p>
        <h1>PetalBot is unreachable</h1>
        <p>The panel could not reach the server.</p>
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </main>
  );
}
