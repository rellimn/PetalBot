import { Columns3, GripVertical, Move, Plus, Settings2, X } from 'lucide-react';
import { useRef, useState, type RefObject } from 'react';
import { Button, Field, IconButton, Input, Menu, useUser } from '@petalbot/ui-sdk';
import type { Preset, PresetColumn, WidgetInstance } from '../app/endpoints.ts';
import { useKnownPanel, usePanels } from '../plugins/registry.ts';
import { usePresetActions } from './api.ts';
import { AddWidgetDialog } from './AddWidgetDialog.tsx';
import { ConfigureInstanceDialog, ConfigureWidgetDialog } from './ConfigureWidgetDialog.tsx';
import dashboard from './dashboard.module.css';
import { columnTemplate } from './DashboardView.tsx';
import styles from './editor.module.css';
import {
  MAX_COLUMNS,
  MIN_WIDTH,
  addColumn,
  addWidget,
  moveWidget,
  normalizeWidths,
  removeColumn,
  removeWidget,
  resizeColumns,
  setWidgetConfig,
  type Slot,
} from './layout.ts';
import { WidgetFrame } from './WidgetFrame.tsx';
import { availableWidgets, needsConfig, newInstance, type AvailableWidget } from './widgets.ts';

type Columns = readonly PresetColumn[];

export interface PresetEditorProps {
  readonly preset: Preset;
  readonly onDone: () => void;
}

/** The live dashboard turned into an editor; nothing is saved until Save. */
export function PresetEditor({ preset, onDone }: PresetEditorProps) {
  const actions = usePresetActions();
  const panels = usePanels();
  const user = useUser();
  const [name, setName] = useState(preset.name);
  const [columns, setColumns] = useState<Columns>(() => normalizeWidths(preset.columns));
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<{
    readonly available: AvailableWidget;
    readonly column: number;
  } | null>(null);
  const [configuring, setConfiguring] = useState<WidgetInstance | null>(null);

  const save = async (): Promise<void> => {
    setSaving(true);
    const saved = await actions.update(preset.id, {
      name: name.trim() === '' ? preset.name : name.trim(),
      columns,
    });
    setSaving(false);
    if (saved) onDone();
  };

  return (
    <>
      <div className={styles.editBar} role="toolbar" aria-label="Edit preset">
        <div className={styles.name}>
          <Field label="Preset name">
            <Input
              value={name}
              maxLength={40}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>
        </div>
        <Button
          icon={Columns3}
          disabled={columns.length >= MAX_COLUMNS}
          onClick={() => {
            setColumns(addColumn);
          }}
        >
          Add column
        </Button>
        <Button
          icon={Plus}
          onClick={() => {
            setAdding(true);
          }}
        >
          Add widget
        </Button>
        <span className={styles.spacer} />
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={saving}
          onClick={() => {
            void save();
          }}
        >
          Save
        </Button>
      </div>
      <EditableColumns
        columns={columns}
        onChange={setColumns}
        onConfigure={setConfiguring}
        container={container}
      />
      {adding ? (
        <AddWidgetDialog
          available={availableWidgets(panels, user.role)}
          columns={columns.length}
          onAdd={(available, column) => {
            setAdding(false);
            if (needsConfig(available.widget)) {
              setPending({ available, column });
            } else {
              setColumns((current) =>
                addWidget(current, column, newInstance(available.ref, available.widget)),
              );
            }
          }}
          onCancel={() => {
            setAdding(false);
          }}
        />
      ) : null}
      {pending ? (
        <ConfigureWidgetDialog
          widget={pending.available.widget}
          title={pending.available.title}
          stored={undefined}
          onSave={(config) => {
            setColumns((current) =>
              addWidget(
                current,
                pending.column,
                newInstance(pending.available.ref, pending.available.widget, config),
              ),
            );
            setPending(null);
            return Promise.resolve();
          }}
          onCancel={() => {
            setPending(null);
          }}
        />
      ) : null}
      {configuring ? (
        <ConfigureInstanceDialog
          instance={configuring}
          onSave={(config) => {
            setColumns((current) => setWidgetConfig(current, configuring.id, config));
            setConfiguring(null);
            return Promise.resolve();
          }}
          onCancel={() => {
            setConfiguring(null);
          }}
        />
      ) : null}
    </>
  );
}

interface EditableColumnsProps {
  readonly columns: Columns;
  readonly onChange: (columns: Columns) => void;
  readonly onConfigure: (instance: WidgetInstance) => void;
  readonly container: RefObject<HTMLDivElement | null>;
}

function EditableColumns({ columns, onChange, onConfigure, container }: EditableColumnsProps) {
  const [dragging, setDragging] = useState<Slot | null>(null);
  const [target, setTarget] = useState<number | null>(null);

  const dropAt = (to: Slot): void => {
    if (dragging === null) return;
    // `to.index` was measured before removing the dragged widget.
    const index =
      dragging.column === to.column && dragging.index < to.index ? to.index - 1 : to.index;
    onChange(moveWidget(columns, dragging, { column: to.column, index }));
    setDragging(null);
    setTarget(null);
  };

  return (
    <div ref={container} className={dashboard.columns} style={columnTemplate({ columns })}>
      {columns.map((column, columnIndex) => (
        <div
          key={columnIndex}
          role="group"
          aria-label={`Column ${String(columnIndex + 1)}`}
          className={styles.column}
          data-drop-target={target === columnIndex || undefined}
          onDragOver={(event) => {
            if (dragging === null) return;
            event.preventDefault();
            setTarget(columnIndex);
          }}
          onDragLeave={() => {
            setTarget(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            dropAt({ column: columnIndex, index: column.widgets.length });
          }}
        >
          <div className={styles.columnHeader}>
            <span>
              Column {columnIndex + 1} · {column.width}%
            </span>
            {columns.length > 1 ? (
              <IconButton
                size="sm"
                label={`Remove column ${String(columnIndex + 1)}`}
                icon={X}
                onClick={() => {
                  onChange(removeColumn(columns, columnIndex));
                }}
              />
            ) : null}
          </div>
          {column.widgets.map((instance, index) => (
            <EditableWidget
              key={instance.id}
              instance={instance}
              slot={{ column: columnIndex, index }}
              columns={columns}
              onChange={onChange}
              onConfigure={onConfigure}
              onDragStart={() => {
                setDragging({ column: columnIndex, index });
              }}
              onDragEnd={() => {
                setDragging(null);
                setTarget(null);
              }}
              onDropBefore={() => {
                dropAt({ column: columnIndex, index });
              }}
            />
          ))}
          {column.widgets.length === 0 ? <p className={styles.hint}>Drop widgets here</p> : null}
          {columnIndex < columns.length - 1 ? (
            <ColumnResizer
              border={columnIndex}
              columns={columns}
              onChange={onChange}
              container={container}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

interface EditableWidgetProps {
  readonly instance: WidgetInstance;
  readonly slot: Slot;
  readonly columns: Columns;
  readonly onChange: (columns: Columns) => void;
  readonly onConfigure: (instance: WidgetInstance) => void;
  readonly onDragStart: () => void;
  readonly onDragEnd: () => void;
  readonly onDropBefore: () => void;
}

function EditableWidget({
  instance,
  slot,
  columns,
  onChange,
  onConfigure,
  onDragStart,
  onDragEnd,
  onDropBefore,
}: EditableWidgetProps) {
  const known = useKnownPanel(instance.plugin);
  const widget = known?.widgets.find((candidate) => candidate.id === instance.widget);
  const title = widget?.title ?? `${instance.plugin} / ${instance.widget}`;
  const count = columns[slot.column]?.widgets.length ?? 0;
  const moves = [
    {
      label: 'Move left',
      disabled: slot.column === 0,
      to: { column: slot.column - 1, index: columns[slot.column - 1]?.widgets.length ?? 0 },
    },
    {
      label: 'Move right',
      disabled: slot.column === columns.length - 1,
      to: { column: slot.column + 1, index: columns[slot.column + 1]?.widgets.length ?? 0 },
    },
    {
      label: 'Move up',
      disabled: slot.index === 0,
      to: { column: slot.column, index: slot.index - 1 },
    },
    {
      label: 'Move down',
      disabled: slot.index === count - 1,
      to: { column: slot.column, index: slot.index + 1 },
    },
  ];
  return (
    <div
      className={styles.widget}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', instance.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDropBefore();
      }}
    >
      <div className={styles.widgetHeader}>
        <GripVertical size={14} aria-hidden />
        <span>{title}</span>
        {widget?.config ? (
          <IconButton
            size="sm"
            label={`Configure ${title}`}
            icon={Settings2}
            onClick={() => {
              onConfigure(instance);
            }}
          />
        ) : null}
        <Menu
          label={`Move ${title}`}
          trigger={<IconButton size="sm" label={`Move ${title}`} icon={Move} />}
          items={moves.map((move) => ({
            label: move.label,
            disabled: move.disabled,
            onSelect: () => {
              onChange(moveWidget(columns, slot, move.to));
            },
          }))}
        />
        <IconButton
          size="sm"
          label={`Remove ${title}`}
          icon={X}
          onClick={() => {
            onChange(removeWidget(columns, slot));
          }}
        />
      </div>
      <div className={styles.widgetBody} inert>
        <WidgetFrame instance={instance} />
      </div>
    </div>
  );
}

interface ColumnResizerProps {
  readonly border: number;
  readonly columns: Columns;
  readonly onChange: (columns: Columns) => void;
  readonly container: RefObject<HTMLDivElement | null>;
}

function ColumnResizer({ border, columns, onChange, container }: ColumnResizerProps) {
  const left = columns[border]?.width ?? MIN_WIDTH;
  const pair = left + (columns[border + 1]?.width ?? MIN_WIDTH);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize columns ${String(border + 1)} and ${String(border + 2)}`}
      aria-valuenow={left}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={pair - MIN_WIDTH}
      tabIndex={0}
      className={styles.resizer}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          onChange(resizeColumns(columns, border, event.key === 'ArrowLeft' ? -2 : 2));
        }
      }}
      onPointerDown={(event) => {
        const width = container.current?.getBoundingClientRect().width ?? 0;
        if (width === 0) return;
        const startX = event.clientX;
        const start = columns;
        const move = (moveEvent: PointerEvent): void => {
          onChange(
            resizeColumns(start, border, Math.round(((moveEvent.clientX - startX) / width) * 100)),
          );
        };
        const up = (): void => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}
