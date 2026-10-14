import { describe, expect, it } from 'vitest';
import { resolveGraph, type GraphNode } from '../src/loader/graph.ts';

const node = (
  id: string,
  version = '1.0.0',
  dependencies: Record<string, string> = {},
  optionalDependencies: Record<string, string> = {},
): GraphNode => ({ id, version, dependencies, optionalDependencies });

const graph = (...nodes: GraphNode[]) => resolveGraph(new Map(nodes.map((n) => [n.id, n])));

describe('resolveGraph', () => {
  it('orders dependencies (and installed optional ones) first, otherwise alphabetically', () => {
    const result = graph(
      node('quotes', '1.0.0', { chat: '^1.0.0' }, { points: '^2.0.0' }),
      node('chat'),
      node('points', '2.1.0'),
      node('alerts'),
    );
    expect(result.problems.size).toBe(0);
    expect(result.order).toEqual(['alerts', 'chat', 'points', 'quotes']);
  });

  it('reports missing required dependencies but tolerates missing optional ones', () => {
    const result = graph(
      node('quotes', '1.0.0', { chat: '^1.0.0' }),
      node('alerts', '1.0.0', {}, { x: '*' }),
    );
    expect(result.problems.get('quotes')).toBe('requires "chat" (not installed)');
    expect(result.problems.has('alerts')).toBe(false);
    expect(result.order).toEqual(['alerts']);
  });

  it('reports version mismatches, also for installed optional dependencies', () => {
    const result = graph(
      node('quotes', '1.0.0', { chat: '^2.0.0' }),
      node('alerts', '1.0.0', {}, { chat: '^3.0.0' }),
      node('chat', '1.4.0'),
    );
    expect(result.problems.get('quotes')).toBe('requires "chat@^2.0.0", found 1.4.0');
    expect(result.problems.get('alerts')).toBe(
      'optional dependency "chat@^3.0.0" is installed in version 1.4.0',
    );
  });

  it('reports dependency cycles', () => {
    const result = graph(node('a', '1.0.0', { b: '*' }), node('b', '1.0.0', { a: '*' }), node('c'));
    expect(result.problems.get('a')).toBe('dependency cycle: a -> b -> a');
    expect(result.problems.get('b')).toBe('dependency cycle: a -> b -> a');
    expect(result.order).toEqual(['c']);
  });

  it('propagates problems to required dependents only', () => {
    const result = graph(
      node('top', '1.0.0', { middle: '*' }),
      node('middle', '1.0.0', { missing: '*' }),
      node('soft', '1.0.0', {}, { middle: '*' }),
    );
    expect(result.problems.get('middle')).toBe('requires "missing" (not installed)');
    expect(result.problems.get('top')).toBe('depends on "middle", which cannot be loaded');
    expect(result.problems.has('soft')).toBe(false);
    expect(result.order).toEqual(['soft']);
  });
});
