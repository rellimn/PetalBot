import type { PresetColumn, WidgetInstance } from '../app/endpoints.ts';

export const MAX_COLUMNS = 3;
/** Smallest column width in percent while editing. */
export const MIN_WIDTH = 10;

export interface Slot {
  readonly column: number;
  readonly index: number;
}

type Columns = readonly PresetColumn[];

/** Whole percentages that sum to 100, each at least MIN_WIDTH (the last column absorbs rounding). */
export function normalizeWidths(columns: Columns): PresetColumn[] {
  const total = columns.reduce((sum, column) => sum + column.width, 0) || 1;
  const widths = columns.map((column) =>
    Math.max(MIN_WIDTH, Math.round((column.width / total) * 100)),
  );
  const excess = widths.reduce((sum, width) => sum + width, 0) - 100;
  // Take the excess (or give the shortfall) from the widest column.
  const widest = widths.indexOf(Math.max(...widths));
  if (widest >= 0) widths[widest] = (widths[widest] ?? 100) - excess;
  return columns.map((column, index) => ({ ...column, width: widths[index] ?? MIN_WIDTH }));
}

/** Moves a widget; `to.index` is its position in the target column after it was removed. */
export function moveWidget(columns: Columns, from: Slot, to: Slot): PresetColumn[] {
  const moved = columns[from.column]?.widgets[from.index];
  if (moved === undefined) return [...columns];
  const without = removeWidget(columns, from);
  return without.map((column, index) => {
    if (index !== to.column) return column;
    const widgets = [...column.widgets];
    widgets.splice(Math.min(Math.max(to.index, 0), widgets.length), 0, moved);
    return { ...column, widgets };
  });
}

export function removeWidget(columns: Columns, slot: Slot): PresetColumn[] {
  return columns.map((column, index) =>
    index === slot.column
      ? { ...column, widgets: column.widgets.filter((_, position) => position !== slot.index) }
      : column,
  );
}

export function addWidget(
  columns: Columns,
  column: number,
  instance: WidgetInstance,
): PresetColumn[] {
  return columns.map((current, index) =>
    index === column ? { ...current, widgets: [...current.widgets, instance] } : current,
  );
}

/** Replaces the config of the instance `id`. */
export function setWidgetConfig(
  columns: Columns,
  id: string,
  config: Readonly<Record<string, unknown>>,
): PresetColumn[] {
  return columns.map((column) => ({
    ...column,
    widgets: column.widgets.map((widget) => (widget.id === id ? { ...widget, config } : widget)),
  }));
}

/** Appends an empty column with an average share; at most MAX_COLUMNS. */
export function addColumn(columns: Columns): Columns {
  if (columns.length >= MAX_COLUMNS) return columns;
  const average = columns.reduce((sum, column) => sum + column.width, 0) / columns.length;
  return normalizeWidths([...columns, { width: average, widgets: [] }]);
}

/** Removes a column; its widgets and width go to the column before it (or after, for the first). */
export function removeColumn(columns: Columns, column: number): Columns {
  const removed = columns[column];
  if (columns.length <= 1 || removed === undefined) return columns;
  const target = column === 0 ? 1 : column - 1;
  const merged = columns.map((current, index) =>
    index === target
      ? {
          width: current.width + removed.width,
          widgets:
            target < column
              ? [...current.widgets, ...removed.widgets]
              : [...removed.widgets, ...current.widgets],
        }
      : current,
  );
  return normalizeWidths(merged.filter((_, index) => index !== column));
}

/** Moves the border after column `border` by `delta` percent, keeping both sides >= MIN_WIDTH. */
export function resizeColumns(columns: Columns, border: number, delta: number): PresetColumn[] {
  const left = columns[border];
  const right = columns[border + 1];
  if (!left || !right) return [...columns];
  const pair = left.width + right.width;
  const next = Math.min(Math.max(left.width + delta, MIN_WIDTH), pair - MIN_WIDTH);
  return columns.map((column, index) => {
    if (index === border) return { ...column, width: next };
    if (index === border + 1) return { ...column, width: pair - next };
    return column;
  });
}
