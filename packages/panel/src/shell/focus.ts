import { createContext, useContext } from 'react';

export interface FocusState {
  /** The dashboard shows only its widgets and the focus strip. */
  readonly focused: boolean;
  readonly setFocused: (focused: boolean) => void;
}

export const FocusContext = createContext<FocusState>({
  focused: false,
  setFocused: () => undefined,
});

export const useFocus = (): FocusState => useContext(FocusContext);
