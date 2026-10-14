import { createContext, useContext } from 'react';
import type { PanelRegistry } from '../plugins/registry.ts';
import type { Session } from './session.ts';

export interface AppServices {
  readonly registry: PanelRegistry;
  readonly session: Session;
  /** The user logged in through PETALBOT_DEV_AUTH. */
  readonly devAuth: boolean;
  /** Leaves the single-page app (logout); tests record it instead. */
  readonly leave: (url: string) => void;
}

export const AppContext = createContext<AppServices | null>(null);

function useAppServices(): AppServices {
  const services = useContext(AppContext);
  if (!services) throw new Error('AppContext is missing');
  return services;
}

export const useRegistry = (): PanelRegistry => useAppServices().registry;
export const useSession = (): Session => useAppServices().session;
export const useDevAuth = (): boolean => useAppServices().devAuth;
export const useLeave = (): ((url: string) => void) => useAppServices().leave;
