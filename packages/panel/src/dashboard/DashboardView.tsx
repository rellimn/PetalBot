import type { CSSProperties } from 'react';
import type { Preset } from '../app/endpoints.ts';
import styles from './dashboard.module.css';
import { WidgetFrame } from './WidgetFrame.tsx';
import { widgetKey } from './widgets.ts';

export const columnTemplate = (preset: Pick<Preset, 'columns'>): CSSProperties =>
  ({
    '--pb-columns': preset.columns
      .map((column) => `minmax(0, ${String(column.width)}fr)`)
      .join(' '),
  }) as CSSProperties;

export function DashboardView({ preset }: { readonly preset: Preset }) {
  return (
    <div className={styles.columns} style={columnTemplate(preset)}>
      {preset.columns.map((column, index) => (
        <div key={index} className={styles.column}>
          {column.widgets.map((ref) => (
            <WidgetFrame key={widgetKey(ref)} widgetRef={ref} />
          ))}
        </div>
      ))}
    </div>
  );
}
