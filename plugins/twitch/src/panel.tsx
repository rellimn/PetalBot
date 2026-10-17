/**
 * The Twitch page: the application's redirect URL, the broadcaster and bot accounts with
 * Connect / Reconnect / Disconnect (owner only), the bot's role and the EventSub connections.
 *
 * Connecting is a top-level navigation to `/api/p/twitch/auth/start` (OAuth needs one). Twitch's
 * callback comes back here with `?connected=<kind>` or `?error=<reason>`, shown as a toast.
 *
 * Runs in the browser; imports the contract, the client and @petalbot/ui-sdk, never server code.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Radio } from 'lucide-react';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Spinner,
  StatusDot,
  definePanel,
  toast,
  useUser,
  type StatusDotProps,
} from '@petalbot/ui-sdk';
import { api } from './client.ts';
import {
  twitchContract,
  type AccountKind,
  type AccountStatus,
  type SocketState,
  type TwitchStatus,
} from './contract.ts';
import styles from './panel.module.css';

const ROLE_NAME: Record<AccountKind, string> = { broadcaster: 'broadcaster', bot: 'bot' };
const TITLE: Record<AccountKind, string> = { broadcaster: 'Broadcaster', bot: 'Bot' };

/** What the OAuth callback's `?error=` means for the owner. */
const ERROR_TEXT: Record<string, string> = {
  'not-configured': 'Set the client ID and secret first',
  'invalid-state': 'The login expired. Try again',
  denied: 'Twitch login was cancelled',
  'same-account': 'Use a different Twitch account for the bot and the broadcaster',
  'missing-scopes': 'Twitch did not grant every permission. Try again',
  'exchange-failed': 'Could not finish the Twitch login',
};

/** Shows the OAuth callback's outcome once, then removes it from the URL. */
function useLoginResult(): void {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const error = params.get('error');
    if (connected === null && error === null) return;
    if (connected === 'broadcaster' || connected === 'bot') {
      toast({ title: `Connected the ${ROLE_NAME[connected]} account`, tone: 'success' });
    } else if (error !== null) {
      toast({ title: ERROR_TEXT[error] ?? 'Could not finish the Twitch login', tone: 'danger' });
    }
    params.delete('connected');
    params.delete('error');
    const rest = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${rest === '' ? '' : `?${rest}`}${window.location.hash}`,
    );
  }, []);
}

const SOCKET_TONE: Record<SocketState, StatusDotProps['tone']> = {
  off: 'idle',
  connecting: 'warning',
  connected: 'ok',
  disconnected: 'danger',
};

function AccountCard({
  kind,
  account,
  isOwner,
  children,
}: {
  readonly kind: AccountKind;
  readonly account: AccountStatus | null;
  readonly isOwner: boolean;
  readonly children?: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const disconnect = api.twitch.disconnect.useMutation({
    success: `Disconnected the ${ROLE_NAME[kind]} account`,
    error: 'Could not disconnect',
  });
  const start = `/api/p/twitch/auth/start?account=${kind}`;
  const verb = account ? 'Reconnect' : 'Connect';
  return (
    <Card
      title={TITLE[kind]}
      actions={
        isOwner ? (
          <div className={styles.row}>
            <a className={styles.link} href={start} aria-label={`${verb} ${ROLE_NAME[kind]}`}>
              {verb}
            </a>
            {account ? (
              <Button
                variant="danger"
                size="sm"
                aria-label={`Disconnect ${ROLE_NAME[kind]}`}
                loading={disconnect.isPending}
                onClick={() => {
                  setConfirming(true);
                }}
              >
                Disconnect
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <div className={styles.row}>
        {account ? (
          <>
            <span>{account.displayName}</span>
            {account.state === 'connected' ? (
              <Badge tone="success">Connected</Badge>
            ) : (
              <Badge tone="warning">Reconnect required</Badge>
            )}
          </>
        ) : (
          <span className={styles.muted}>Not connected</span>
        )}
      </div>
      {children}
      <ConfirmDialog
        open={confirming}
        title={`Disconnect the ${ROLE_NAME[kind]} account?`}
        message="PetalBot revokes its access at Twitch and forgets the account."
        confirmLabel="Disconnect"
        tone="danger"
        busy={disconnect.isPending}
        onConfirm={() => {
          setConfirming(false);
          disconnect.mutate({ account: kind });
        }}
        onCancel={() => {
          setConfirming(false);
        }}
      />
    </Card>
  );
}

function BotNotes({ status }: { readonly status: TwitchStatus }) {
  if (!status.bot) return <Banner>Connect a bot account to enable chat</Banner>;
  if (status.botRole === 'none' || status.botRole === 'vip') {
    return (
      <Banner tone="warning">
        Bot is not a moderator: lower chat rate limit, no timeouts or deletions
      </Banner>
    );
  }
  return null;
}

function TwitchPage() {
  useLoginResult();
  const isOwner = useUser().role === 'owner';
  const query = api.twitch.status.useQuery();
  const status = query.data;
  if (!status) return <Spinner />;
  return (
    <div className={styles.page}>
      <Card title="Application">
        {status.credentialsRejected ? (
          <Banner tone="danger">
            Twitch rejected the client ID or secret. Save the current ones from your Twitch
            application
          </Banner>
        ) : null}
        <p className={styles.muted}>
          {status.configured ? null : 'Not configured. '}
          Register this redirect URL in your Twitch application, then set its{' '}
          <a href="/settings/twitch">Client ID and secret</a>.
        </p>
        <div className={styles.row}>
          <code className={styles.url}>{status.redirectUrl}</code>
          <Button
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(status.redirectUrl).then(() => {
                toast({ title: 'Copied the redirect URL', tone: 'success' });
              });
            }}
          >
            Copy
          </Button>
        </div>
      </Card>
      <AccountCard kind="broadcaster" account={status.broadcaster} isOwner={isOwner} />
      <AccountCard kind="bot" account={status.bot} isOwner={isOwner}>
        <BotNotes status={status} />
      </AccountCard>
      <Card title="EventSub">
        <div className={styles.sockets}>
          {(['broadcaster', 'bot'] as const).map((kind) => (
            <span key={kind} className={styles.row}>
              <StatusDot
                tone={SOCKET_TONE[status.eventSub[kind]]}
                label={`${TITLE[kind]}: ${status.eventSub[kind]}`}
                pulse={status.eventSub[kind] === 'connecting'}
              />
              {TITLE[kind]}
            </span>
          ))}
        </div>
      </Card>
    </div>
  );
}

export default definePanel(twitchContract, {
  pages: [
    { path: 'accounts', title: 'Twitch', icon: Radio, minRole: 'mod', component: TwitchPage },
  ],
});
