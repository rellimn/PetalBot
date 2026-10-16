/**
 * The counter's panel: the Counters page and the dashboard widget.
 *
 * Runs in the browser, loaded by the PetalBot panel. It may import the contract, the client and
 * @petalbot/ui-sdk, never server code. Components use ui-sdk components and this file's CSS
 * module (no Tailwind), so they follow the user's color scheme and density.
 *
 * Guide: docs/plugin-guide.md#6-the-panel.
 * Read next: src/overlays/display.tsx.
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
  Spinner,
  definePanel,
  type WidgetProps,
} from '@petalbot/ui-sdk';
import { presentCounterFailure } from './failure.ts';
import { api } from './client.ts';
import { counterContract, type Counter } from './contract.ts';
import styles from './panel.module.css';

/** One counter with its actions. Mutations raise their own toasts on failure. */
function CounterRow({ counter }: { readonly counter: Counter }) {
  const increment = api.counter.increment.useMutation({
    error: 'Could not count',
    presentFailure: presentCounterFailure,
  });
  const reset = api.counter.reset.useMutation({
    error: 'Could not reset',
    presentFailure: presentCounterFailure,
  });
  const remove = api.counter.remove.useMutation({
    presentFailure: presentCounterFailure,
    success: `Removed ${counter.name}`,
    error: 'Could not remove',
  });
  return (
    <div className={styles.row}>
      <span className={styles.name}>{counter.name}</span>
      <span className={styles.value}>
        <Numeric>{counter.value}</Numeric>
      </span>
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="sm"
          aria-label={`+1 ${counter.name}`}
          loading={increment.isPending}
          onClick={() => {
            increment.mutate({ counter: counter.id });
          }}
        >
          +1
        </Button>
        <Button
          size="sm"
          loading={reset.isPending}
          onClick={() => {
            reset.mutate({ counter: counter.id });
          }}
        >
          Reset
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={remove.isPending}
          onClick={() => {
            remove.mutate({ counter: counter.id });
          }}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

/** A name field and a Create button; a duplicate name comes back as a validation error. */
function CreateCounter() {
  const create = api.counter.create.useMutation({ error: 'Could not create the counter' });
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
  // Live through the client definition: refetched on listChanged, patched on changed.
  const counters = api.counter.list.useQuery();
  return (
    <Card title="Counters">
      {counters.isPending ? <Spinner label="Loading counters" /> : null}
      {counters.data?.length === 0 ? <EmptyState title="No counters yet" /> : null}
      {counters.data?.map((counter) => (
        <CounterRow key={counter.id} counter={counter} />
      ))}
      <CreateCounter />
    </Card>
  );
}

/**
 * The dashboard widget. Each placed instance has its own config: the counter picked with
 * choice('counter.options'). The dashboard titles it "Counter · <name>" by itself.
 */
function CounterWidget({ config }: WidgetProps<typeof counterContract, 'value'>) {
  const counter = api.counter.get.useQuery({ counter: config.counter });
  const increment = api.counter.increment.useMutation({
    error: 'Could not count',
    presentFailure: presentCounterFailure,
  });
  if (counter.isPending) return <Spinner label="Loading the counter" />;
  // null, not an error: the counter was deleted after this widget was placed.
  if (counter.data === null || counter.data === undefined) {
    return <p className={styles.muted}>This counter was deleted</p>;
  }
  return (
    <div className={styles.widget}>
      <span className={styles.value}>
        <Numeric>{counter.data.value}</Numeric>
      </span>
      <Button
        size="sm"
        onClick={() => {
          increment.mutate({ counter: config.counter });
        }}
      >
        +1
      </Button>
    </div>
  );
}

export default definePanel(counterContract, {
  pages: [
    { path: 'counter', title: 'Counters', icon: Hash, minRole: 'mod', component: CountersPage },
  ],
  // Keys must match the contract's widgets; the config type comes from there.
  widgets: {
    value: {
      title: 'Counter',
      description: 'One counter with a +1 button',
      minRole: 'mod',
      component: CounterWidget,
    },
  },
  // No custom settings form: the generated one handles `step` well enough.
});
