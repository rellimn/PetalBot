import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_APPEARANCE, useApi, useToast } from '@petalbot/ui-sdk';
import { loadPreferences, savePreferences, type Preferences } from './endpoints.ts';

export const PREFERENCES_KEY = ['me', 'preferences'] as const;
export const DEFAULT_PREFERENCES: Preferences = { ...DEFAULT_APPEARANCE, activePreset: null };

export function usePreferences(): Preferences {
  const api = useApi();
  const query = useQuery({ queryKey: PREFERENCES_KEY, queryFn: () => loadPreferences(api) });
  return query.data ?? DEFAULT_PREFERENCES;
}

/** Saves preferences optimistically; reverts and shows a toast when saving fails. */
export function useSavePreferences(): (next: Preferences) => void {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (next: Preferences) => savePreferences(api, next),
    onMutate: (next) => {
      const previous = queryClient.getQueryData<Preferences>(PREFERENCES_KEY);
      queryClient.setQueryData(PREFERENCES_KEY, next);
      return { previous };
    },
    onError: (error, _next, context) => {
      if (context?.previous) queryClient.setQueryData(PREFERENCES_KEY, context.previous);
      toast({
        title: 'Saving your preferences failed',
        description: error.message,
        tone: 'danger',
      });
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(PREFERENCES_KEY, saved);
    },
  });
  return (next) => {
    mutation.mutate(next);
  };
}
