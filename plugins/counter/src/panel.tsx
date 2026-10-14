/**
 * Interim panel (M4r1): the Counters page and the widget on the M4 client API. M4r2 rewrites
 * this file for the new client (`api.counter.list.useQuery()`), the configurable `value` widget
 * and its full documentation.
 */
import { useState } from 'react';
import { Hash } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Numeric,
  definePanel,
  toast,
} from '@petalbot/ui-sdk';
import { counter } from './client.ts';
import { counterContract, type Counter } from './contract.ts';
import styles from './panel.module.css';

function useCounters() {
  return counter.useRpc('counter.list', undefined, {
    refreshOn: ['counter.changed', 'counter.listChanged'],
  });
}

function CounterRow({ item }: { readonly item: Counter }) {
  const increment = counter.useMutation('counter.increment');
  const reset = counter.useMutation('counter.reset');
  const remove = counter.useMutation('counter.remove');
  return (
    <div className={styles.row}>
      <span className={styles.name}>{item.name}</span>
      <span className={styles.value}>
        <Numeric>{item.value}</Numeric>
      </span>
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="sm"
          loading={increment.isPending}
          onClick={() => {
            increment.mutate({ counter: item.id });
          }}
        >
          +1
        </Button>
        <Button
          size="sm"
          loading={reset.isPending}
          onClick={() => {
            reset.mutate({ counter: item.id });
          }}
        >
          Reset
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={remove.isPending}
          onClick={() => {
            remove.mutate({ counter: item.id });
          }}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

function CreateCounter() {
  const create = counter.useMutation('counter.create');
  const [name, setName] = useState('');
  return (
    <form
      className={styles.create}
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(
          { name },
          {
            onSuccess: () => {
              setName('');
            },
            onError: (error) => {
              toast({
                title: 'Could not create the counter',
                description: error.message,
                tone: 'danger',
              });
            },
          },
        );
      }}
    >
      <Field label="New counter">
        <Input
          value={name}
          maxLength={40}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </Field>
      <Button
        type="submit"
        variant="primary"
        loading={create.isPending}
        disabled={name.trim() === ''}
      >
        Create
      </Button>
    </form>
  );
}

function CountersPage() {
  const list = useCounters();
  return (
    <Card title="Counters">
      {list.data?.length === 0 ? <EmptyState title="No counters yet" /> : null}
      {list.data?.map((item) => (
        <CounterRow key={item.id} item={item} />
      ))}
      <CreateCounter />
    </Card>
  );
}

function CountersWidget() {
  const list = useCounters();
  return (
    <div className={styles.widget}>
      {list.data?.map((item) => (
        <CounterRow key={item.id} item={item} />
      ))}
    </div>
  );
}

export default definePanel(counterContract, {
  pages: [
    { path: 'counter', title: 'Counters', icon: Hash, minRole: 'mod', component: CountersPage },
  ],
  widgets: [
    {
      id: 'value',
      title: 'Counters',
      description: 'All counters with +1 buttons',
      minRole: 'mod',
      component: CountersWidget,
    },
  ],
});
