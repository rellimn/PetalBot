import { useState, type CSSProperties } from 'react';
import type { Preset, WidgetInstance } from '../app/endpoints.ts';
import { usePresetActions } from './api.ts';
import { ConfigureInstanceDialog } from './ConfigureWidgetDialog.tsx';
import styles from './dashboard.module.css';
import { setWidgetConfig } from './layout.ts';
import { WidgetFrame } from './WidgetFrame.tsx';

export const columnTemplate = (preset: Pick<Preset, 'columns'>): CSSProperties =>
  ({
    '--pb-columns': preset.columns
      .map((column) => `minmax(0, ${String(column.width)}fr)`)
      .join(' '),
  }) as CSSProperties;

export function DashboardView({ preset }: { readonly preset: Preset }) {
  const actions = usePresetActions();
  const [configuring, setConfiguring] = useState<WidgetInstance | null>(null);
  return (
    <div className={styles.columns} style={columnTemplate(preset)}>
      {preset.columns.map((column, index) => (
        <div key={index} className={styles.column}>
          {column.widgets.map((instance) => (
            <WidgetFrame
              key={instance.id}
              instance={instance}
              onConfigure={() => {
                setConfiguring(instance);
              }}
            />
          ))}
        </div>
      ))}
      {configuring ? (
        <ConfigureInstanceDialog
          instance={configuring}
          onSave={async (config) => {
            const saved = await actions.update(preset.id, {
              name: preset.name,
              columns: setWidgetConfig(preset.columns, configuring.id, config),
            });
            if (saved) setConfiguring(null);
          }}
          onCancel={() => {
            setConfiguring(null);
          }}
        />
      ) : null}
    </div>
  );
}
