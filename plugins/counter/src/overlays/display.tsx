/**
 * The counter's OBS overlay: one counter, big, kept live.
 *
 * Runs in the overlay host (an OBS browser source), not in the panel: no login and no panel
 * state. Its client may only use what the contract's overlay declaration lists
 * (counter.get, counter.changed, counter.listChanged); the server enforces that as well.
 *
 * Read next: test/server.test.ts.
 */
import {
  createOverlayClient,
  defineOverlay,
  type OverlayConfig,
  type OverlayProps,
} from '@petalbot/ui-sdk';
import { counterContract } from '../contract.ts';
import styles from './display.module.css';

const display = createOverlayClient(counterContract, 'display', {
  queries: {
    'counter.get': {
      // A removed counter answers null after this refetch, and the overlay disappears.
      refreshOn: ['counter.listChanged'],
      update: {
        'counter.changed': (data, event, input) =>
          data !== null && event.payload.counter === input.counter
            ? { ...data, value: event.payload.value }
            : data,
      },
    },
  },
});

function Display({ config }: OverlayProps<OverlayConfig<typeof counterContract, 'display'>>) {
  const current = display.counter.get.useQuery({ counter: config.counter });
  // Nothing while loading, and nothing for a deleted counter: OBS shows a transparent page.
  if (!current.data) return null;
  return (
    <div className={styles.display} data-size={config.size}>
      <span className={styles.label}>{current.data.name}</span>
      <span className={styles.value}>{current.data.value}</span>
    </div>
  );
}

export default defineOverlay(counterContract, 'display', { component: Display });
