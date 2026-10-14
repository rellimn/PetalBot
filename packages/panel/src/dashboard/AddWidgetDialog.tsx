import { useState } from 'react';
import { Button, Dialog, Field, Select } from '@petalbot/ui-sdk';
import type { WidgetRef } from '../app/endpoints.ts';
import styles from './editor.module.css';
import { widgetKey, type AvailableWidget } from './widgets.ts';

export interface AddWidgetDialogProps {
  /** Widgets the user may add that are not on the preset yet. */
  readonly available: readonly AvailableWidget[];
  readonly columns: number;
  readonly onAdd: (ref: WidgetRef, column: number) => void;
  readonly onCancel: () => void;
}

export function AddWidgetDialog({ available, columns, onAdd, onCancel }: AddWidgetDialogProps) {
  const [column, setColumn] = useState(0);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="Add a widget"
      {...(available.length === 0
        ? { description: 'Every widget you may use is already on this preset.' }
        : {})}
    >
      {columns > 1 ? (
        <Field label="Column">
          <Select
            value={String(column)}
            options={Array.from({ length: columns }, (_, index) => ({
              value: String(index),
              label: `Column ${String(index + 1)}`,
            }))}
            onChange={(event) => {
              setColumn(Number(event.target.value));
            }}
          />
        </Field>
      ) : null}
      <ul className={styles.list}>
        {available.map((widget) => (
          <li key={widgetKey(widget.ref)} className={styles.item}>
            <div>
              <strong>{widget.title}</strong> · {widget.pluginId}
              {widget.description === undefined ? null : <p>{widget.description}</p>}
            </div>
            <Button
              size="sm"
              aria-label={`Add ${widget.title}`}
              onClick={() => {
                onAdd(widget.ref, column);
              }}
            >
              Add
            </Button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
