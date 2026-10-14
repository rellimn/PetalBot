import { Hash } from 'lucide-react';
import { Button, Card, Numeric, definePanel, useToast } from '@petalbot/ui-sdk';
import { counter } from './client.ts';
import { counterContract } from './contract.ts';
import styles from './panel.module.css';

function CounterValue() {
  const current = counter.useRpc('counter.get', {}, { refreshOn: ['counter.changed'] });
  return (
    <span className={styles.value}>
      <Numeric>{current.data?.value ?? '…'}</Numeric>
    </span>
  );
}

function CounterPage() {
  const increment = counter.useMutation('counter.increment');
  const reset = counter.useMutation('counter.reset');
  const toast = useToast();
  return (
    <Card title="Current value">
      <CounterValue />
      <div className={styles.actions}>
        <Button
          variant="primary"
          loading={increment.isPending}
          onClick={() => {
            increment.mutate({});
          }}
        >
          Add
        </Button>
        <Button
          loading={reset.isPending}
          onClick={() => {
            reset.mutate(
              {},
              {
                onSuccess: () => {
                  toast({ title: 'Counter reset', tone: 'success' });
                },
                onError: (error) => {
                  toast({ title: 'Reset failed', description: error.message, tone: 'danger' });
                },
              },
            );
          }}
        >
          Reset
        </Button>
      </div>
    </Card>
  );
}

function CounterWidget() {
  const increment = counter.useMutation('counter.increment');
  return (
    <div className={styles.widget}>
      <CounterValue />
      <Button
        size="sm"
        onClick={() => {
          increment.mutate({});
        }}
      >
        +1
      </Button>
    </div>
  );
}

export default definePanel(counterContract, {
  pages: [
    { path: 'counter', title: 'Counter', icon: Hash, minRole: 'mod', component: CounterPage },
  ],
  widgets: [
    {
      id: 'value',
      title: 'Counter',
      description: 'The current value with a +1 button',
      minRole: 'mod',
      component: CounterWidget,
    },
  ],
});
