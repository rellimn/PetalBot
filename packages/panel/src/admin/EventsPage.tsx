import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { EventEnvelope } from '@petalbot/sdk';
import { Button, EmptyState, Field, Input, Spinner, useApi, useConnection } from '@petalbot/ui-sdk';
import { loadEvents } from '../app/endpoints.ts';
import { OwnerOnly } from '../app/OwnerOnly.tsx';
import { errorText } from '../plugins/actions.tsx';
import styles from './admin.module.css';
import { formatTime, hasData } from './format.ts';
import { frameBatcher } from './live.ts';

const EVENT_PAGE_SIZE = 100;
const LIVE_LIMIT = 1000;

export function EventsPage() {
  return (
    <OwnerOnly>
      <EventsContent />
    </OwnerOnly>
  );
}

function EventsContent() {
  const api = useApi();
  const connection = useConnection();
  const [filter, setFilter] = useState('');
  const [live, setLive] = useState<readonly EventEnvelope[]>([]);

  const queryClient = useQueryClient();
  useEffect(() => {
    let received = 0;
    const batch = frameBatcher<EventEnvelope>((events) => {
      setLive((current) => [...events.toReversed(), ...current].slice(0, LIVE_LIMIT));
      // Live events start to drop off at the cap: let the history catch up first, so nothing
      // falls into a gap between the two.
      received += events.length;
      if (received >= LIVE_LIMIT) {
        received = 0;
        void queryClient.invalidateQueries({ queryKey: ['events'] });
      }
    });
    const stop = connection.inspect((event) => {
      batch.push(event);
    });
    return () => {
      stop();
      batch.cancel();
    };
  }, [connection, queryClient]);

  const history = useInfiniteQuery({
    queryKey: ['events'],
    refetchOnMount: 'always',
    queryFn: ({ pageParam }) => loadEvents(api, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.length < EVENT_PAGE_SIZE ? undefined : page.at(-1)?.id),
  });

  const loaded = history.data?.pages.flat() ?? [];
  const newest = loaded[0]?.id ?? '';
  const needle = filter.trim().toLowerCase();
  const events = [...live.filter((event) => event.id > newest), ...loaded].filter((event) =>
    event.name.toLowerCase().includes(needle),
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>Events</h1>
      </header>
      <div className={styles.toolbar}>
        <Field label="Filter by name">
          <Input
            value={filter}
            placeholder="e.g. chat."
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        </Field>
      </div>
      {history.isPending ? (
        <Spinner label="Loading events" />
      ) : history.isError ? (
        <EmptyState title="Events could not be loaded">{errorText(history.error)}</EmptyState>
      ) : events.length === 0 ? (
        <EmptyState title="No events">Nothing matches yet.</EmptyState>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Event</th>
              <th scope="col">Source</th>
              <th scope="col">Payload</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className={styles.muted}>{formatTime(event.timestamp)}</td>
                <td>{event.name}</td>
                <td className={styles.muted}>
                  {event.source}
                  {event.depth > 0 ? ` · depth ${String(event.depth)}` : ''}
                </td>
                <td>
                  {hasData(event.payload) ? (
                    <details className={styles.details}>
                      <summary>payload</summary>
                      <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                    </details>
                  ) : (
                    <span className={styles.muted}>-</span>
                  )}
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
