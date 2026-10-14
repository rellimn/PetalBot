/**
 * Interim overlay (M4r1): shows one counter, kept live by patching the cached result from each
 * `counter.changed` event. M4r2 moves the live options into the client definition and documents
 * this file fully.
 */
import {
  createOverlayClient,
  defineOverlay,
  type OverlayConfig,
  type OverlayProps,
} from '@petalbot/ui-sdk';
import { counterContract } from '../contract.ts';
import styles from './display.module.css';

/** Module scope, as the React Compiler requires. */
const display = createOverlayClient(counterContract, 'display');

function Display({ config }: OverlayProps<OverlayConfig<typeof counterContract, 'display'>>) {
  const current = display.useRpc(
    'counter.get',
    { counter: config.counter },
    {
      update: {
        'counter.changed': (data, event) =>
          data?.id === event.payload.counter ? { ...data, value: event.payload.value } : data,
      },
    },
  );
  return (
    <div className={styles.display} data-size={config.size}>
      <span className={styles.label}>{current.data?.name ?? 'Counter'}</span>
      <span className={styles.value}>{current.data?.value ?? '–'}</span>
    </div>
  );
}

export default defineOverlay(counterContract, 'display', { component: Display });
