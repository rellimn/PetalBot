import { describe, expect, it } from 'vitest';
import {
  addColumn,
  addWidget,
  moveWidget,
  normalizeWidths,
  removeColumn,
  removeWidget,
  resizeColumns,
} from '../src/dashboard/layout.ts';

const w = (widget: string) => ({ plugin: 'p', widget });
const columns = [
  { width: 70, widgets: [w('a'), w('b')] },
  { width: 30, widgets: [w('c')] },
];

describe('preset layout', () => {
  it('normalizes widths to whole percentages', () => {
    expect(
      normalizeWidths([
        { width: 2, widgets: [] },
        { width: 1, widgets: [] },
      ]).map((c) => c.width),
    ).toEqual([67, 33]);
    expect(
      normalizeWidths([
        { width: 99, widgets: [] },
        { width: 1, widgets: [] },
      ]).map((c) => c.width),
    ).toEqual([90, 10]);
  });

  it('moves widgets within and across columns', () => {
    expect(
      moveWidget(columns, { column: 0, index: 0 }, { column: 0, index: 1 })[0]?.widgets,
    ).toEqual([w('b'), w('a')]);
    const across = moveWidget(columns, { column: 0, index: 1 }, { column: 1, index: 0 });
    expect(across.map((column) => column.widgets)).toEqual([[w('a')], [w('b'), w('c')]]);
    expect(columns[0]?.widgets).toEqual([w('a'), w('b')]);
  });

  it('adds and removes widgets', () => {
    expect(addWidget(columns, 1, w('d'))[1]?.widgets).toEqual([w('c'), w('d')]);
    expect(removeWidget(columns, { column: 0, index: 0 })[0]?.widgets).toEqual([w('b')]);
  });

  it('adds up to three columns and removes them, keeping their widgets', () => {
    const three = addColumn(columns);
    expect(three.map((column) => column.width)).toEqual([47, 20, 33]);
    expect(addColumn(three)).toBe(three);
    const merged = removeColumn(three, 0);
    expect(merged.map((column) => column.widgets)).toEqual([[w('a'), w('b'), w('c')], []]);
    expect(merged.map((column) => column.width)).toEqual([67, 33]);
    expect(removeColumn([{ width: 100, widgets: [] }], 0)).toEqual([{ width: 100, widgets: [] }]);
  });

  it('resizes neighbouring columns within the limits', () => {
    expect(resizeColumns(columns, 0, 5).map((column) => column.width)).toEqual([75, 25]);
    expect(resizeColumns(columns, 0, 50).map((column) => column.width)).toEqual([90, 10]);
    expect(resizeColumns(columns, 0, -80).map((column) => column.width)).toEqual([10, 90]);
  });
});
