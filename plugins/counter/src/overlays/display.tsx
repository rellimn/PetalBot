import { useState } from 'react';
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
  const current = display.useRpc('counter.get', {});
  const [live, setLive] = useState<number | null>(null);
  display.useEvent('counter.changed', (event) => {
    setLive(event.payload.value);
  });
  const value = live ?? current.data?.value;
  return (
    <div className={styles.display} data-size={config.size}>
      <span className={styles.label}>{config.label}</span>
      <span className={styles.value}>{value ?? '–'}</span>
    </div>
  );
}

export default defineOverlay(counterContract, 'display', { component: Display });
