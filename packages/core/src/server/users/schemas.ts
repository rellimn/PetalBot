import { z } from 'zod';

export const DARK_SCHEMES = [
  'rose',
  'lavender',
  'spring-leaf',
  'peach-blossom',
  'dark-gray',
] as const;
export const LIGHT_SCHEMES = ['light', 'cream'] as const;

export const preferencesSchema = z.object({
  darkScheme: z.enum(DARK_SCHEMES).default('rose'),
  lightScheme: z.enum(LIGHT_SCHEMES).default('light'),
  mode: z
    .enum(['system', 'dark', 'light'])
    .default('system')
    .describe('system follows the browser; dark and light force one of the two schemes'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  activePreset: z
    .string()
    .nullable()
    .default(null)
    .describe("Id of one of the user's presets; null shows the first"),
});
export type Preferences = z.output<typeof preferencesSchema>;

/** A serialized widget config may be at most 8 KiB. */
export const MAX_WIDGET_CONFIG_BYTES = 8 * 1024;

export const widgetInstanceSchema = z
  .object({
    id: z.string().min(1).max(64).describe('Instance id, unique within the preset'),
    plugin: z.string().min(1).max(64),
    widget: z.string().min(1).max(64),
    config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "The instance config, validated against the widget's schema when the plugin is known",
      ),
  })
  .refine(
    (entry) =>
      entry.config === undefined ||
      new TextEncoder().encode(JSON.stringify(entry.config)).length <= MAX_WIDGET_CONFIG_BYTES,
    { message: 'A widget config may be at most 8 KiB', path: ['config'] },
  );

export const presetColumnSchema = z.object({
  width: z.number().int().min(1).max(100).describe('Relative width of the column'),
  widgets: z.array(widgetInstanceSchema).max(20),
});

export const presetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    columns: z.array(presetColumnSchema).min(1).max(3),
  })
  .refine(
    (preset) => {
      const ids = preset.columns.flatMap((column) => column.widgets.map((widget) => widget.id));
      return new Set(ids).size === ids.length;
    },
    { message: 'Widget instance ids must be unique within a preset', path: ['columns'] },
  );
export type PresetInput = z.output<typeof presetInputSchema>;

export interface Preset extends PresetInput {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export const MAX_PRESETS = 20;
