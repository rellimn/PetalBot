import { z } from 'zod';

// Shared wire schemas. They carry no OpenAPI ids; http/schemas.ts adds ids via `.meta()` copies.

export const panelUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['owner', 'mod']),
});

export const pluginInfoSchema = z.object({
  id: z.string(),
  version: z.string(),
  dir: z.string(),
  state: z.enum(['disabled', 'starting', 'running', 'stopping', 'failed']),
  enabled: z.boolean(),
  degraded: z.boolean(),
  error: z.string().optional(),
  dependencies: z.array(z.string()).readonly(),
  optionalDependencies: z.array(z.string()).readonly(),
  hasPanel: z.boolean().describe('The build has a panel entry'),
  hasSettings: z
    .boolean()
    .optional()
    .describe('Absent until the core has loaded the plugin definition'),
  panel: z
    .object({
      entry: z.string().describe('URL of the panel bundle'),
      styles: z.array(z.string()).readonly().describe('URLs of its stylesheets'),
    })
    .optional()
    .describe('Present while the plugin runs with a readable panel bundle'),
});

export const envelopeSchema = z.object({
  id: z.string().describe('ULID, sortable by creation time'),
  name: z.string().describe('Qualified event name, e.g. "chat.message"'),
  payload: z.unknown(),
  source: z.string().describe('Id of the emitting plugin'),
  timestamp: z.number(),
  causedBy: z.string().optional().describe('Envelope id of the event whose handler emitted this'),
  depth: z.number().int(),
});

export const wireErrorSchema = z.object({ code: z.string(), message: z.string() });

export const logEntrySchema = z.object({
  id: z.number().int().describe('Increasing; pass it as `before` to page back'),
  time: z.number().describe('Unix time in milliseconds'),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  plugin: z.string().optional().describe('Absent for core entries'),
  message: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export const overlayBundleSchema = z.object({
  hash: z.string(),
  entry: z.string().describe('URL of the overlay bundle'),
  styles: z.array(z.string()).readonly().describe('URLs of its stylesheets'),
});
