import { z } from 'zod';
import { preferencesSchema, presetInputSchema } from '../users/schemas.ts';
import { envelopeSchema, logEntrySchema, panelUserSchema, pluginInfoSchema } from '../schemas.ts';

// Response schemas with OpenAPI component ids. `.meta()` returns a copy: call it once per id.

export const errorBodySchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      plugins: z
        .array(z.string())
        .readonly()
        .optional()
        .describe('The affected plugins, for code confirmation_required'),
      issues: z
        .array(
          z.object({
            path: z.array(z.union([z.string(), z.number()])),
            message: z.string(),
          }),
        )
        .readonly()
        .optional()
        .describe('For code validation: what failed where (zod issues)'),
    }),
  })
  .meta({ id: 'ErrorBody' });

export const panelUserBody = panelUserSchema.meta({ id: 'PanelUser' });

export const meBody = z
  .object({
    user: panelUserBody,
    devAuth: z.boolean().describe('True if PETALBOT_DEV_AUTH logged this user in'),
  })
  .meta({ id: 'Me' });

export const pluginInfoBody = pluginInfoSchema.meta({ id: 'PluginInfo' });

export const pluginListBody = z
  .object({
    plugins: z.array(pluginInfoBody).readonly(),
    problems: z
      .array(z.object({ dir: z.string(), message: z.string() }).meta({ id: 'DiscoveryProblem' }))
      .readonly()
      .describe('Plugin folders that could not be read'),
  })
  .meta({ id: 'PluginList' });

export const deletedDataBody = z
  .object({
    droppedTables: z.array(z.string()).readonly(),
    overlayInstances: z.number().int().describe('Overlay instances deleted with the data'),
  })
  .meta({ id: 'DeletedData' });

export const settingsBody = z
  .object({
    values: z.record(z.string(), z.unknown()),
    schema: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe('JSON Schema (input) of the settings; null if the plugin has none'),
  })
  .meta({ id: 'PluginSettings' });

export const settingsValuesBody = z
  .object({ values: z.record(z.string(), z.unknown()) })
  .meta({ id: 'PluginSettingsValues' });

export const overlayInstanceBody = z
  .object({
    id: z.string(),
    pluginId: z.string(),
    overlay: z.string(),
    name: z.string(),
    config: z.record(z.string(), z.unknown()),
    createdAt: z.number(),
    rotatedAt: z.number(),
  })
  .meta({ id: 'OverlayInstance' });

export const declaredOverlayBody = z
  .object({
    pluginId: z.string(),
    overlay: z.string(),
    schema: z
      .record(z.string(), z.unknown())
      .describe('JSON Schema (input) of the instance config'),
    hasBundle: z.boolean().describe('The plugin has a built bundle for this overlay'),
  })
  .meta({ id: 'DeclaredOverlay' });

export const overlayListBody = z
  .object({
    instances: z.array(overlayInstanceBody).readonly(),
    overlays: z
      .array(declaredOverlayBody)
      .readonly()
      .describe('Overlays the running plugins declare (instances can be created for these)'),
  })
  .meta({ id: 'OverlayList' });

export const overlayTokenBody = z
  .object({
    instance: overlayInstanceBody,
    token: z.string().describe('Shown only now; store the URL in OBS'),
    url: z.string().describe('Browser-source URL including the token'),
  })
  .meta({ id: 'OverlayToken' });

export const eventPageBody = z
  .object({ events: z.array(envelopeSchema.meta({ id: 'EventEnvelope' })).readonly() })
  .meta({ id: 'EventPage' });

export const logPageBody = z
  .object({ entries: z.array(logEntrySchema.meta({ id: 'LogEntry' })).readonly() })
  .meta({ id: 'LogPage' });

export const preferencesBody = preferencesSchema.meta({ id: 'Preferences' });
export const presetInputBody = presetInputSchema.meta({ id: 'PresetInput' });

export const presetBody = z
  .object({
    id: z.string(),
    name: z.string(),
    columns: z.array(
      z.object({
        width: z.number().int(),
        widgets: z
          .array(
            z.object({
              id: z.string(),
              plugin: z.string(),
              widget: z.string(),
              config: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .readonly(),
      }),
    ),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ id: 'Preset' });

export const presetListBody = z
  .object({ presets: z.array(presetBody).readonly() })
  .meta({ id: 'PresetList' });
