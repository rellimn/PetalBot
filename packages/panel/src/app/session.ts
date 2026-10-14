import { createStore, useStore, type ReadonlyStore } from '@petalbot/ui-sdk';
import { useSession } from './context.ts';

export interface SessionState {
  readonly ended: boolean;
}

/** Whether the login session ended while the panel was open (401 or WS close 4001). */
export interface Session {
  readonly state: ReadonlyStore<SessionState>;
  /** The current value, for code outside components. */
  readonly ended: boolean;
  end(): void;
  resume(): void;
}

export function createSession(): Session {
  const state = createStore<SessionState>({ ended: false }, { name: 'petalbot/session' });
  const set = (ended: boolean): void => {
    if (state.get().ended !== ended) state.set({ ended });
  };
  return {
    state,
    get ended() {
      return state.get().ended;
    },
    end: () => {
      set(true);
    },
    resume: () => {
      set(false);
    },
  };
}

export function useSessionEnded(): boolean {
  const session = useSession();
  return useStore(session.state, (state) => state.ended);
}
