import semver from 'semver';

export interface GraphNode {
  readonly id: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
}

export interface ResolvedGraph {
  /** Plugins without problems, dependencies first. */
  readonly order: readonly string[];
  /** Plugins that cannot be loaded, with a readable reason. */
  readonly problems: ReadonlyMap<string, string>;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function resolveGraph(nodes: ReadonlyMap<string, GraphNode>): ResolvedGraph {
  const problems = new Map<string, string>();
  for (const node of nodes.values()) {
    const problem = versionProblem(node, nodes);
    if (problem !== undefined) problems.set(node.id, problem);
  }
  for (const cycle of findCycles(nodes)) {
    const description = `dependency cycle: ${[...cycle, cycle[0] ?? ''].join(' -> ')}`;
    for (const id of cycle) if (!problems.has(id)) problems.set(id, description);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes.values()) {
      if (problems.has(node.id)) continue;
      const failed = Object.keys(node.dependencies).find((dep) => problems.has(dep));
      if (failed !== undefined) {
        problems.set(node.id, `depends on "${failed}", which cannot be loaded`);
        changed = true;
      }
    }
  }
  return { order: topologicalOrder(nodes, problems), problems };
}

function versionProblem(
  node: GraphNode,
  nodes: ReadonlyMap<string, GraphNode>,
): string | undefined {
  for (const [dep, range] of Object.entries(node.dependencies)) {
    const target = nodes.get(dep);
    if (!target) return `requires "${dep}" (not installed)`;
    if (!semver.satisfies(target.version, range)) {
      return `requires "${dep}@${range}", found ${target.version}`;
    }
  }
  for (const [dep, range] of Object.entries(node.optionalDependencies)) {
    const target = nodes.get(dep);
    if (target && !semver.satisfies(target.version, range)) {
      return `optional dependency "${dep}@${range}" is installed in version ${target.version}`;
    }
  }
  return undefined;
}

/** Required dependencies plus installed optional ones. */
function edgesOf(node: GraphNode, nodes: ReadonlyMap<string, GraphNode>): string[] {
  return [...Object.keys(node.dependencies), ...Object.keys(node.optionalDependencies)]
    .filter((dep) => nodes.has(dep))
    .sort(byId);
}

function findCycles(nodes: ReadonlyMap<string, GraphNode>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (node: GraphNode): void => {
    state.set(node.id, 'visiting');
    stack.push(node.id);
    for (const dep of edgesOf(node, nodes)) {
      const depState = state.get(dep);
      const depNode = nodes.get(dep);
      if (depState === 'visiting') cycles.push(stack.slice(stack.indexOf(dep)));
      else if (depState === undefined && depNode) visit(depNode);
    }
    stack.pop();
    state.set(node.id, 'done');
  };
  for (const id of [...nodes.keys()].sort(byId)) {
    const node = nodes.get(id);
    if (node && !state.has(id)) visit(node);
  }
  return cycles;
}

function topologicalOrder(
  nodes: ReadonlyMap<string, GraphNode>,
  problems: ReadonlyMap<string, string>,
): string[] {
  const remaining = new Map(
    [...nodes].filter(([id]) => !problems.has(id)).sort(([a], [b]) => byId(a, b)),
  );
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].find((node) =>
      edgesOf(node, nodes).every((dep) => !remaining.has(dep)),
    );
    if (!ready) break;
    order.push(ready.id);
    remaining.delete(ready.id);
  }
  return order;
}
