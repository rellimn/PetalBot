/**
 * The Activity widget: whether each connection is live, and the latest stream events.
 */
import { Spinner, StatusDot, EmptyState, definePanel } from '@petalbot/ui-sdk';
import { api } from './client.ts';
import { streamContract } from './contract.ts';
import { describeEvent, messageOf } from './describe.ts';
import styles from './panel.module.css';

const time = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function ActivityWidget() {
  const recent = api.stream.recent.useQuery();
  const status = api.stream.status.useQuery();
  if (recent.isPending || status.isPending) return <Spinner label="Loading the activity" />;
  const connections = Object.entries(status.data ?? {});
  const entries = recent.data ?? [];
  return (
    <div className={styles.widget}>
      {connections.length === 0 ? (
        <p className={styles.muted}>No platform connected</p>
      ) : (
        <ul className={styles.status} aria-label="Connections">
          {connections.map(([id, { live, since }]) => (
            <li key={id}>
              <StatusDot tone={live ? 'ok' : 'idle'} label={live ? 'Live' : 'Offline'} />
              <span>{id}</span> {/* The dot already says Live or Offline. */}
              {live && since !== undefined ? (
                <span className={styles.muted}>since {time(since)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {entries.length === 0 ? (
        <EmptyState title="No activity yet" />
      ) : (
        <ol className={styles.entries} aria-label="Activity">
          {entries.map((entry) => {
            const message = messageOf(entry.event);
            return (
              <li key={entry.id} className={styles.entry} data-type={entry.event.type}>
                <time className={styles.muted} dateTime={new Date(entry.timestamp).toISOString()}>
                  {time(entry.timestamp)}
                </time>
                <span>{describeEvent(entry.event)}</span>
                {message === undefined ? null : <q className={styles.message}>{message}</q>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export default definePanel(streamContract, {
  widgets: {
    activity: {
      title: 'Activity',
      description: 'Follows, subscriptions, raids and support, and whether you are live',
      minRole: 'mod',
      component: ActivityWidget,
    },
  },
});
