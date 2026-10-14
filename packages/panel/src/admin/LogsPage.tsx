import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Select,
  Spinner,
  useApi,
  useConnection,
  usePlugins,
  type LogEntry,
  type LogLevel,
  type Tone,
} from '@petalbot/ui-sdk';
import { loadLogs } from '../app/endpoints.ts';
import { OwnerOnly } from '../app/OwnerOnly.tsx';
import { errorText } from '../plugins/actions.tsx';
import styles from './admin.module.css';
import { formatTime, hasData } from './format.ts';
import { frameBatcher } from './live.ts';

export const LOG_PAGE_SIZE = 200;
/** Live entries kept while the page is open (shown on top of the cached history). */
const LIVE_LIMIT = 1000;

const LEVELS: readonly { value: LogLevel; label: string }[] = [
  { value: 'debug', label: 'Everything' },
  { value: 'info', label: 'Info and up' },
  { value: 'warn', label: 'Warnings and errors' },
  { value: 'error', label: 'Errors only' },
];
const RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };
const TONE: Readonly<Record<LogLevel, Tone>> = {
  debug: 'neutral',
  info: 'accent',
  warn: 'warning',
  error: 'danger',
};

export function LogsPage() {
  return (
    <OwnerOnly>
      <LogsContent />
    </OwnerOnly>
  );
}

function LogsContent() {
  const api = useApi();
  const connection = useConnection();
  const plugins = usePlugins();
  const [plugin, setPlugin] = useState('');
  const [level, setLevel] = useState<LogLevel>('debug');
  const [live, setLive] = useState<readonly LogEntry[]>([]);

  const queryClient = useQueryClient();
  useEffect(() => {
    let received = 0;
    const batch = frameBatcher<LogEntry>((entries) => {
      setLive((current) => [...entries.toReversed(), ...current].slice(0, LIVE_LIMIT));
      // Live entries start to drop off at the cap: let the history catch up first, so nothing
      // falls into a gap between the two.
      received += entries.length;
      if (received >= LIVE_LIMIT) {
        received = 0;
        void queryClient.invalidateQueries({ queryKey: ['logs'] });
      }
    });
    const stop = connection.streamLogs((entry) => {
      batch.push(entry);
    });
    return () => {
      stop();
      batch.cancel();
    };
  }, [connection, queryClient]);

  useEffect(() => {
    let wasOpen = connection.status === 'open';
    return connection.state.subscribe((state) => {
      const open = state.status === 'open';
      if (open && !wasOpen) {
        // The core may have restarted (log ids start again at 1) and entries logged while the
        // socket was down are missing: start over from the history.
        setLive([]);
        void queryClient.invalidateQueries({ queryKey: ['logs'] });
      }
      wasOpen = open;
    });
  }, [connection, queryClient]);

  const history = useInfiniteQuery({
    queryKey: ['logs', plugin, level],
    refetchOnMount: 'always',
    queryFn: ({ pageParam }) =>
      loadLogs(api, {
        ...(plugin === '' ? {} : { plugin }),
        ...(level === 'debug' ? {} : { level }),
        ...(pageParam === undefined ? {} : { before: pageParam }),
        limit: LOG_PAGE_SIZE,
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => (page.length < LOG_PAGE_SIZE ? undefined : page.at(-1)?.id),
  });

  const loaded = history.data?.pages.flat() ?? [];
  const newest = loaded[0]?.id ?? 0;
  const matches = (entry: LogEntry): boolean =>
    RANK[entry.level] >= RANK[level] &&
    (plugin === '' || (plugin === 'core' ? entry.plugin === undefined : entry.plugin === plugin));
  const entries = [...live.filter((entry) => entry.id > newest && matches(entry)), ...loaded];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>Logs</h1>
      </header>
      <div className={styles.toolbar}>
        <Field label="Plugin">
          <Select
            value={plugin}
            onChange={(event) => {
              setPlugin(event.target.value);
            }}
            options={[
              { value: '', label: 'All' },
              { value: 'core', label: 'Core' },
              ...[...plugins.keys()].sort().map((id) => ({ value: id, label: id })),
            ]}
          />
        </Field>
        <Field label="Level">
          <Select
            value={level}
            onChange={(event) => {
              setLevel(event.target.value as LogLevel);
            }}
            options={LEVELS}
          />
        </Field>
      </div>
      {history.isPending ? (
        <Spinner label="Loading logs" />
      ) : history.isError ? (
        <EmptyState title="Logs could not be loaded">{errorText(history.error)}</EmptyState>
      ) : entries.length === 0 ? (
        <EmptyState title="No log entries">Nothing matches these filters yet.</EmptyState>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Level</th>
              <th scope="col">Plugin</th>
              <th scope="col">Message</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className={styles.muted}>{formatTime(entry.time)}</td>
                <td>
                  <Badge tone={TONE[entry.level]}>{entry.level}</Badge>
                </td>
                <td className={styles.muted}>{entry.plugin ?? 'core'}</td>
                <td>
                  <div>{entry.message}</div>
                  {hasData(entry.data) ? (
                    <details className={styles.details}>
                      <summary>data</summary>
                      <pre>{JSON.stringify(entry.data, null, 2)}</pre>
                    </details>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {history.hasNextPage ? (
        <div>
          <Button
            loading={history.isFetchingNextPage}
            onClick={() => {
              void history.fetchNextPage();
            }}
          >
            Load older
          </Button>
        </div>
      ) : null}
    </div>
  );
}
