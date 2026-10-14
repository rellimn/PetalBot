import {
  checkOverlayDefinition,
  createStore,
  type OverlayBundleInfo,
  type OverlayDefinition,
  type PetalConnection,
  type ReadonlyStore,
} from '@petalbot/ui-sdk';

/** What the page shows: nothing until a matching bundle is loaded. */
export type OverlayView =
  | { readonly status: 'waiting' }
  | { readonly status: 'ready'; readonly definition: OverlayDefinition }
  | { readonly status: 'failed'; readonly message: string };

export interface OverlayRuntimeOptions {
  readonly pluginId: string;
  readonly overlay: string;
  /** Default: dynamic `import()`. */
  readonly importModule?: (url: string) => Promise<unknown>;
  /** Default: `location.reload()`. */
  readonly reload?: () => void;
}

const defaultImport = (url: string): Promise<unknown> => import(/* @vite-ignore */ url);
const defaultReload = (): void => {
  location.reload();
};

/**
 * Loads the overlay's bundle and decides what to show. New code (another hash after one was
 * loaded) reloads the page: module instances and React state of old code can't be swapped safely.
 */
export class OverlayRuntime {
  readonly #pluginId: string;
  readonly #overlay: string;
  readonly #import: (url: string) => Promise<unknown>;
  readonly #reload: () => void;
  readonly #state = createStore<{ readonly view: OverlayView }>({ view: { status: 'waiting' } });
  #wanted: string | null = null;
  #loaded: { readonly hash: string; readonly definition: OverlayDefinition } | undefined;
  #reloading = false;

  constructor(options: OverlayRuntimeOptions) {
    this.#pluginId = options.pluginId;
    this.#overlay = options.overlay;
    this.#import = options.importModule ?? defaultImport;
    this.#reload = options.reload ?? defaultReload;
  }

  /** What the page shows; read it with `useStore(runtime.state, (s) => s.view)`. */
  get state(): ReadonlyStore<{ readonly view: OverlayView }> {
    return this.#state;
  }

  get view(): OverlayView {
    return this.#state.get().view;
  }

  /** Feeds the connection's overlay bundle into the runtime; returns a function that stops. */
  follow(connection: Pick<PetalConnection, 'state'>): () => void {
    return connection.state.subscribe((state, previous) => {
      if (state.overlay?.bundle !== previous.overlay?.bundle) {
        this.update(state.overlay?.bundle ?? null);
      }
    });
  }

  update(bundle: OverlayBundleInfo | null): void {
    if (bundle === null) {
      this.#wanted = null;
      this.#set({ status: 'waiting' });
      return;
    }
    if (bundle.hash === this.#wanted) return;
    this.#wanted = bundle.hash;
    if (this.#loaded) {
      if (this.#loaded.hash === bundle.hash) {
        this.#set({ status: 'ready', definition: this.#loaded.definition });
      } else if (!this.#reloading) {
        this.#reloading = true;
        this.#reload();
      }
      return;
    }
    void this.#load(bundle);
  }

  async #load(bundle: OverlayBundleInfo): Promise<void> {
    let definition: OverlayDefinition;
    try {
      const module = (await this.#import(bundle.entry)) as { default?: unknown } | undefined;
      definition = checkOverlayDefinition(module?.default, this.#pluginId, this.#overlay);
    } catch (error) {
      if (this.#wanted !== bundle.hash) return;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `PetalBot: the overlay ${this.#pluginId}/${this.#overlay} failed to load`,
        error,
      );
      this.#set({ status: 'failed', message });
      return;
    }
    if (this.#wanted !== bundle.hash) return;
    this.#addStyles(bundle.styles);
    this.#loaded = { hash: bundle.hash, definition };
    this.#set({ status: 'ready', definition });
  }

  #addStyles(styles: readonly string[]): void {
    for (const href of styles) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.petalbotOverlay = this.#pluginId;
      document.head.append(link);
    }
  }

  #set(view: OverlayView): void {
    this.#state.set({ view });
  }
}
