import { X } from 'lucide-react';
import { Toast } from 'radix-ui';
import { useEffect, type ReactNode } from 'react';
import { createStore, useStore } from '../store.ts';
import styles from './Toaster.module.css';

export interface ToastInput {
  readonly title: string;
  readonly description?: string;
  readonly tone?: 'info' | 'success' | 'warning' | 'danger';
  /** Default 5000 ms; danger toasts stay 10 000 ms. */
  readonly durationMs?: number;
}

interface ShownToast extends ToastInput {
  readonly id: number;
}

interface ToastState {
  readonly toasts: readonly ShownToast[];
  /** Mounted `<Toaster>`s. */
  readonly hosts: number;
}

/** Older toasts are dropped beyond this many. */
const MAX_TOASTS = 5;

const toasts = createStore<ToastState>({ toasts: [], hosts: 0 }, { name: 'petalbot/toasts' });
let nextToastId = 1;

/**
 * Shows a toast (bottom right). Works anywhere: components, event handlers, plugin code. Pages
 * without a `<Toaster>` (overlays) show nothing.
 */
export function toast(input: ToastInput): void {
  const id = nextToastId++;
  toasts.set((state) => ({
    toasts: [...state.toasts.slice(-(MAX_TOASTS - 1)), { ...input, id }],
  }));
}

function dismiss(id: number): void {
  toasts.set((state) => ({ toasts: state.toasts.filter((shown) => shown.id !== id) }));
}

/** Renders the toasts. When the last Toaster unmounts, the remaining toasts are dropped. */
export function Toaster({ children }: { readonly children: ReactNode }) {
  const shown = useStore(toasts, (state) => state.toasts);
  useEffect(() => {
    toasts.set((state) => ({ hosts: state.hosts + 1 }));
    return () => {
      toasts.set((state) => ({ hosts: state.hosts - 1 }));
      // A microtask later: StrictMode remounts at once and must keep the list.
      queueMicrotask(() => {
        if (toasts.get().hosts === 0) toasts.reset();
      });
    };
  }, []);
  return (
    <Toast.Provider swipeDirection="right" label="Notifications">
      {children}
      {shown.map((item) => (
        <Toast.Root
          key={item.id}
          className={styles.toast}
          data-tone={item.tone ?? 'info'}
          type={item.tone === 'danger' ? 'foreground' : 'background'}
          duration={item.durationMs ?? (item.tone === 'danger' ? 10_000 : 5_000)}
          onOpenChange={(open) => {
            if (!open) dismiss(item.id);
          }}
        >
          <div className={styles.text}>
            <Toast.Title className={styles.title}>{item.title}</Toast.Title>
            {item.description !== undefined ? (
              <Toast.Description className={styles.description}>
                {item.description}
              </Toast.Description>
            ) : null}
          </div>
          <Toast.Close className={styles.close} aria-label="Dismiss">
            <X size={14} aria-hidden />
          </Toast.Close>
        </Toast.Root>
      ))}
      <Toast.Viewport className={styles.viewport} />
    </Toast.Provider>
  );
}

/** The global `toast`, for code that prefers a hook. */
export function useToast(): (input: ToastInput) => void {
  return toast;
}
