import {
  checkPanelDefinition,
  createStore,
  useStore,
  type PanelDefinition,
  type PluginInfo,
  type ReadonlyStore,
} from '@petalbot/ui-sdk';
import { useRegistry } from '../app/context.ts';

export type PanelState =
  | { readonly status: 'loading'; readonly entry: string }
  | { readonly status: 'ready'; readonly entry: string; readonly panel: PanelDefinition }
  | { readonly status: 'error'; readonly entry: string; readonly message: string };

export interface RegistryState {
  /** Bundles of running plugins, by plugin id. */
  readonly states: ReadonlyMap<string, PanelState>;
  /** The last good definition of every plugin seen in this session (also while stopped). */
  readonly known: ReadonlyMap<string, PanelDefinition>;
}

export interface PanelRegistryOptions {
  /** Default: dynamic `import()` of the bundle URL. */
  readonly importModule?: (url: string) => Promise<unknown>;
}

const defaultImport = (url: string): Promise<unknown> => import(/* @vite-ignore */ url);

function without<V>(map: ReadonlyMap<string, V>, id: string): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.delete(id);
  return next;
}

/** Loads the panel bundles of running plugins and swaps them when a plugin is reloaded. */
export class PanelRegistry {
  readonly #import: (url: string) => Promise<unknown>;
  /** The entry each plugin should show right now. */
  readonly #wanted = new Map<string, string>();
  readonly #links = new Map<string, HTMLLinkElement[]>();
  readonly #state = createStore<RegistryState>(
    { states: new Map(), known: new Map() },
    { name: 'petalbot/registry' },
  );

  constructor(options: PanelRegistryOptions = {}) {
    this.#import = options.importModule ?? defaultImport;
  }

  /** Bundle states and known definitions; changes with every load, swap or drop. */
  get state(): ReadonlyStore<RegistryState> {
    return this.#state;
  }

  get states(): ReadonlyMap<string, PanelState> {
    return this.#state.get().states;
  }

  get known(): ReadonlyMap<string, PanelDefinition> {
    return this.#state.get().known;
  }

  /** Loads bundles of running plugins with a panel and drops all others. */
  sync(plugins: ReadonlyMap<string, PluginInfo>): void {
    for (const info of plugins.values()) {
      const panel = info.state === 'running' ? info.panel : undefined;
      if (panel === undefined) {
        this.#drop(info.id, false);
      } else if (this.#wanted.get(info.id) !== panel.entry) {
        this.#wanted.set(info.id, panel.entry);
        void this.#load(info.id, panel.entry, panel.styles);
      }
    }
    for (const id of new Set([...this.states.keys(), ...this.known.keys()])) {
      if (!plugins.has(id)) this.#drop(id, true);
    }
  }

  async #load(id: string, entry: string, styles: readonly string[]): Promise<void> {
    if (this.states.get(id)?.status !== 'ready') this.#setState(id, { status: 'loading', entry });
    let panel: PanelDefinition;
    try {
      const module = (await this.#import(entry)) as { default?: unknown } | undefined;
      panel = checkPanelDefinition(module?.default, id);
    } catch (error) {
      if (this.#wanted.get(id) !== entry) return;
      this.#setState(id, {
        status: 'error',
        entry,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (this.#wanted.get(id) !== entry) return;
    this.#replaceStyles(id, styles);
    this.#state.set((state) => ({
      states: new Map(state.states).set(id, { status: 'ready', entry, panel }),
      known: new Map(state.known).set(id, panel),
    }));
  }

  #drop(id: string, forget: boolean): void {
    this.#wanted.delete(id);
    this.#replaceStyles(id, []);
    const { states, known } = this.#state.get();
    const dropState = states.has(id);
    const dropKnown = forget && known.has(id);
    if (!dropState && !dropKnown) return;
    this.#state.set({
      states: dropState ? without(states, id) : states,
      known: dropKnown ? without(known, id) : known,
    });
  }

  #replaceStyles(id: string, styles: readonly string[]): void {
    const added = styles.map((href) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.petalbotPlugin = id;
      document.head.append(link);
      return link;
    });
    for (const link of this.#links.get(id) ?? []) link.remove();
    if (added.length > 0) this.#links.set(id, added);
    else this.#links.delete(id);
  }

  #setState(id: string, state: PanelState): void {
    this.#state.set((current) => ({ states: new Map(current.states).set(id, state) }));
  }
}

export function usePanels(): ReadonlyMap<string, PanelState> {
  const registry = useRegistry();
  return useStore(registry.state, (state) => state.states);
}

/** One plugin's bundle; re-renders only when it changes. */
export function usePanel(pluginId: string): PanelState | undefined {
  const registry = useRegistry();
  return useStore(registry.state, (state) => state.states.get(pluginId));
}

export function useKnownPanels(): ReadonlyMap<string, PanelDefinition> {
  const registry = useRegistry();
  return useStore(registry.state, (state) => state.known);
}

export function useKnownPanel(pluginId: string): PanelDefinition | undefined {
  const registry = useRegistry();
  return useStore(registry.state, (state) => state.known.get(pluginId));
}
