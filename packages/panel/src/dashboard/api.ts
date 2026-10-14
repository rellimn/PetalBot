import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi, useToast } from '@petalbot/ui-sdk';
import {
  createPreset,
  deletePreset,
  loadPresets,
  updatePreset,
  type Preset,
  type PresetInput,
} from '../app/endpoints.ts';
import { PREFERENCES_KEY } from '../app/preferences.ts';
import { errorText } from '../plugins/actions.tsx';

export const PRESETS_KEY = ['me', 'presets'] as const;

export function usePresets() {
  const api = useApi();
  return useQuery({ queryKey: PRESETS_KEY, queryFn: () => loadPresets(api) });
}

export interface PresetActions {
  create(input: PresetInput): Promise<Preset | undefined>;
  update(id: string, input: PresetInput): Promise<Preset | undefined>;
  remove(id: string): Promise<boolean>;
}

/** Preset changes that keep the cached list current and toast on failure. */
export function usePresetActions(): PresetActions {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const setList = (update: (list: readonly Preset[]) => readonly Preset[]): void => {
    queryClient.setQueryData<readonly Preset[]>(PRESETS_KEY, (current) => update(current ?? []));
  };
  const fail = (title: string, error: unknown): void => {
    toast({ title, description: errorText(error), tone: 'danger' });
  };
  return {
    async create(input) {
      try {
        const preset = await createPreset(api, input);
        setList((list) => [...list, preset]);
        return preset;
      } catch (error) {
        fail('Creating the preset failed', error);
        return undefined;
      }
    },
    async update(id, input) {
      try {
        const preset = await updatePreset(api, id, input);
        setList((list) => list.map((current) => (current.id === id ? preset : current)));
        return preset;
      } catch (error) {
        fail('Saving the preset failed', error);
        return undefined;
      }
    },
    async remove(id) {
      try {
        await deletePreset(api, id);
        setList((list) => list.filter((current) => current.id !== id));
        void queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY });
        return true;
      } catch (error) {
        fail('Deleting the preset failed', error);
        return false;
      }
    },
  };
}
