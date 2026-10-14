import styles from './pages.module.css';

const MESSAGES: Readonly<Record<string, { title: string; text: string }>> = {
  forbidden: {
    title: 'No access',
    text: 'Your account is not in a PetalBot group. Ask the streamer to add it.',
  },
  expired: {
    title: 'The login expired',
    text: 'It took too long, or the login was started in another browser.',
  },
  unavailable: {
    title: 'Login is unavailable',
    text: 'The login provider cannot be reached right now.',
  },
  failed: { title: 'Logging in failed', text: 'The login provider refused the login.' },
};

/** `/login-error?reason=…` (shown without a session). */
export function LoginErrorPage({ reason }: { readonly reason: string | null }) {
  const message = MESSAGES[reason ?? 'failed'] ?? MESSAGES.failed;
  return (
    <main className={styles.standalone}>
      <div className={styles.box}>
        <p className={styles.logo}>✿ PetalBot</p>
        <h1>{message?.title}</h1>
        <p>{message?.text}</p>
        <a href="/auth/login">Try again</a>
      </div>
    </main>
  );
}
