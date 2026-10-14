import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { PetalBotError, ValidationError, type OverlayDef } from '@petalbot/sdk';
import { errorMessage } from '../../names.ts';
import { DependencyActionRequired } from '../../plugin-manager.ts';
import type { AppDeps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import type { OverlayInstance } from '../overlays/instance-store.ts';
import { requireRole, type AppEnv } from './middleware.ts';
import { SECURITY, errors, json } from './responses.ts';
import {
  deletedDataBody,
  eventPageBody,
  logPageBody,
  overlayInstanceBody,
  overlayListBody,
  overlayTokenBody,
  pluginInfoBody,
  pluginListBody,
  pluginSecretBody,
  pluginSecretListBody,
  settingsBody,
  settingsValuesBody,
} from './schemas.ts';

const OWNER = 'Minimum role: owner.';
const MOD = 'Minimum role: mod.';
const pluginParams = z.object({ id: z.string().describe('Plugin id') });
const secretParams = z.object({
  id: z.string().describe('Plugin id'),
  name: z.string().describe('Secret name'),
});
/** Longest value a panel may store. */
export const MAX_SECRET_VALUE_LENGTH = 16_384;
const instanceParams = z.object({ id: z.string().describe('Overlay instance id') });
const configSchema = z.record(z.string(), z.unknown());
const instanceName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .describe('Tells instances apart in the overlay manager, e.g. the OBS scene');

const jsonBody = <S extends z.ZodType>(schema: S, required: boolean) => ({
  required,
  content: { 'application/json': { schema } },
});

export function registerAdminRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const { manager, kernel, overlays, eventLog, config } = deps;

  const requirePlugin = (id: string): void => {
    if (!manager.list().some((plugin) => plugin.id === id)) {
      throw new ApiError(404, 'not_found', `Unknown plugin "${id}"`);
    }
  };

  /** Runs a manager action and turns its errors into API errors. */
  const action = async <T>(id: string, run: () => Promise<T>): Promise<T> => {
    requirePlugin(id);
    try {
      return await run();
    } catch (error) {
      if (error instanceof DependencyActionRequired) {
        throw new ApiError(409, 'confirmation_required', error.message, error.plugins);
      }
      if (error instanceof PetalBotError) throw error;
      throw new ApiError(409, 'conflict', errorMessage(error));
    }
  };

  const overlayDef = (pluginId: string, overlay: string): OverlayDef => {
    const contract = kernel.contract(pluginId);
    if (!contract) throw new ApiError(409, 'unavailable', `Plugin "${pluginId}" is not running`);
    const declared = contract.overlays ?? {};
    const def = Object.hasOwn(declared, overlay) ? declared[overlay] : undefined;
    if (!def) {
      throw new ApiError(404, 'not_found', `Plugin "${pluginId}" declares no overlay "${overlay}"`);
    }
    return def;
  };

  const checkConfig = (pluginId: string, overlay: string, value: unknown): void => {
    const result = overlayDef(pluginId, overlay).config.safeParse(value);
    if (!result.success) {
      // Body-relative paths, as the body validation reports them: the panel maps both alike.
      throw new ValidationError(
        `config of overlay "${pluginId}/${overlay}"`,
        result.error.issues.map((issue) => ({ ...issue, path: ['config', ...issue.path] })),
      );
    }
  };

  /** The overlays running plugins declare, with their config schema. */
  const declaredOverlays = () =>
    manager
      .list()
      .filter((info) => info.state === 'running')
      .flatMap((info) =>
        Object.entries(kernel.contract(info.id)?.overlays ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([overlay, def]) => ({
            pluginId: info.id,
            overlay,
            schema: z.toJSONSchema(def.config, { io: 'input', unrepresentable: 'any' }),
            hasBundle: manager.overlaySnapshot(info.id, overlay) !== undefined,
          })),
      );

  const findInstance = (id: string): OverlayInstance => {
    const instance = overlays.get(id);
    if (!instance) throw new ApiError(404, 'not_found', `Unknown overlay instance "${id}"`);
    return instance;
  };

  const overlayUrl = (instance: OverlayInstance, token: string): string =>
    new URL(
      `/overlay/${instance.pluginId}/${instance.overlay}/${instance.id}?t=${token}`,
      config.publicUrl,
    ).href;

  // --- plugins ---

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/plugins',
      tags: ['plugins'],
      summary: 'List plugins',
      description: MOD,
      security: SECURITY,
      responses: { 200: json(pluginListBody, 'All discovered plugins'), ...errors(401, 403) },
    }),
    (c) => {
      requireRole(c, 'mod');
      return c.json({ plugins: manager.list(), problems: manager.discoveryProblems() }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/plugins/rescan',
      tags: ['plugins'],
      summary: 'Re-read plugin manifests',
      description: OWNER,
      security: SECURITY,
      responses: { 204: { description: 'Rescanned' }, ...errors(401, 403) },
    }),
    async (c) => {
      requireRole(c, 'owner');
      await manager.rescan();
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/plugins/{id}/enable',
      tags: ['plugins'],
      summary: 'Enable a plugin',
      description: `${OWNER} Without withDependencies, answers 409 confirmation_required listing the dependencies that would be enabled too.`,
      security: SECURITY,
      request: {
        params: pluginParams,
        body: jsonBody(z.object({ withDependencies: z.boolean().optional() }), false),
      },
      responses: {
        200: json(pluginInfoBody, 'The plugin after enabling'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (c) => {
      requireRole(c, 'owner');
      const { id } = c.req.valid('param');
      const { withDependencies } = c.req.valid('json');
      await action(id, () => manager.enable(id, { withDependencies: withDependencies === true }));
      return c.json(manager.get(id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/plugins/{id}/disable',
      tags: ['plugins'],
      summary: 'Disable a plugin',
      description: `${OWNER} Without withDependents, answers 409 confirmation_required listing the dependents that would be disabled too. Data is kept.`,
      security: SECURITY,
      request: {
        params: pluginParams,
        body: jsonBody(z.object({ withDependents: z.boolean().optional() }), false),
      },
      responses: {
        200: json(pluginInfoBody, 'The plugin after disabling'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (c) => {
      requireRole(c, 'owner');
      const { id } = c.req.valid('param');
      const { withDependents } = c.req.valid('json');
      await action(id, () => manager.disable(id, { withDependents: withDependents === true }));
      return c.json(manager.get(id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/plugins/{id}/reload',
      tags: ['plugins'],
      summary: 'Reload a running plugin with fresh code',
      description: `${OWNER} Running dependents are restarted too.`,
      security: SECURITY,
      request: { params: pluginParams },
      responses: {
        200: json(pluginInfoBody, 'The plugin after reloading'),
        ...errors(401, 403, 404, 409),
      },
    }),
    async (c) => {
      requireRole(c, 'owner');
      const { id } = c.req.valid('param');
      await action(id, () => manager.reload(id));
      return c.json(manager.get(id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/plugins/{id}/data',
      tags: ['plugins'],
      summary: "Delete a disabled plugin's data",
      description: `${OWNER} Drops its tables, kv, settings, secrets and overlay instances. confirm must equal the plugin id.`,
      security: SECURITY,
      request: {
        params: pluginParams,
        body: jsonBody(
          z.object({ confirm: z.string().describe('Must equal the plugin id') }),
          true,
        ),
      },
      responses: {
        200: json(deletedDataBody, 'What was deleted'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (c) => {
      requireRole(c, 'owner');
      const { id } = c.req.valid('param');
      if (c.req.valid('json').confirm !== id) {
        throw new ApiError(400, 'validation', `Type the plugin id "${id}" to confirm`);
      }
      const droppedTables = await action(id, () => manager.deleteData(id));
      const overlayInstances = overlays.deleteByPlugin(id);
      return c.json({ droppedTables, overlayInstances }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/plugins/{id}/settings',
      tags: ['plugins'],
      summary: 'Read plugin settings',
      description: `${OWNER} Also works for stopped plugins.`,
      security: SECURITY,
      request: { params: pluginParams },
      responses: {
        200: json(settingsBody, 'Stored values and the settings schema'),
        ...errors(401, 403, 404, 409),
      },
    }),
    async (c) => {
      requireRole(c, 'owner');
      const { id } = c.req.valid('param');
      const { values, schema } = await action(id, () => manager.settings(id));
      return c.json(
        {
          values: values as Record<string, unknown>,
          schema: schema
            ? (z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
                string,
                unknown
              >)
            : null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/plugins/{id}/settings',
      tags: ['plugins'],
      summary: 'Update plugin settings',
      description: `${OWNER} The patch is merged into the stored values and validated as a whole. Running plugins are notified.`,
      security: SECURITY,
      request: { params: pluginParams, body: jsonBody(configSchema, true) },
      responses: {
        200: json(settingsValuesBody, 'The values after the update'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (c) => {
      requireRole(c, 'owner');
      const { id } = c.req.valid('param');
      const patch = c.req.valid('json');
      const values = await action(id, () => manager.updateSettings(id, patch));
      return c.json({ values: values as Record<string, unknown> }, 200);
    },
  );

  const noSecret = (id: string, name: string): ApiError =>
    new ApiError(404, 'not_found', `Plugin "${id}" has no user-settable secret "${name}"`);

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/plugins/{id}/secrets',
      tags: ['plugins'],
      summary: 'List user-settable secrets',
      description: `${OWNER} Names, labels and whether a value is set; never the values. Also works for stopped plugins.`,
      security: SECURITY,
      request: { params: pluginParams },
      responses: {
        200: json(pluginSecretListBody, 'The user-settable secrets, in declaration order'),
        ...errors(401, 403, 404, 409),
      },
    }),
    async (c) => {
      requireRole(c, 'owner');
      const { id } = c.req.valid('param');
      const secrets = await action(id, () => manager.secrets(id));
      return c.json({ secrets }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/plugins/{id}/secrets/{name}',
      tags: ['plugins'],
      summary: 'Set a user-settable secret',
      description: `${OWNER} Surrounding whitespace is trimmed; an empty value deletes the secret. The value is never returned. Running plugins are notified.`,
      security: SECURITY,
      request: {
        params: secretParams,
        body: jsonBody(
          z.object({ value: z.string().max(MAX_SECRET_VALUE_LENGTH).describe('The new value') }),
          true,
        ),
      },
      responses: {
        200: json(pluginSecretBody, 'The secret after the write'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (c) => {
      requireRole(c, 'owner');
      const { id, name } = c.req.valid('param');
      const { value } = c.req.valid('json');
      const status = await action(id, () => manager.setSecret(id, name, value));
      if (!status) throw noSecret(id, name);
      return c.json(status, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/plugins/{id}/secrets/{name}',
      tags: ['plugins'],
      summary: 'Delete a user-settable secret',
      description: `${OWNER} Running plugins are notified.`,
      security: SECURITY,
      request: { params: secretParams },
      responses: { 204: { description: 'Deleted' }, ...errors(401, 403, 404, 409) },
    }),
    async (c) => {
      requireRole(c, 'owner');
      const { id, name } = c.req.valid('param');
      const status = await action(id, () => manager.deleteSecret(id, name));
      if (!status) throw noSecret(id, name);
      return c.body(null, 204);
    },
  );

  // --- overlays ---

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/overlays',
      tags: ['overlays'],
      summary: 'List overlay instances',
      description: `${OWNER} Tokens are never listed. Also lists the overlays running plugins declare.`,
      security: SECURITY,
      responses: { 200: json(overlayListBody, 'All overlay instances'), ...errors(401, 403) },
    }),
    (c) => {
      requireRole(c, 'owner');
      return c.json({ instances: overlays.list(), overlays: declaredOverlays() }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/overlays',
      tags: ['overlays'],
      summary: 'Create an overlay instance',
      description: `${OWNER} The plugin must be running. The response is the only time the token is shown.`,
      security: SECURITY,
      request: {
        body: jsonBody(
          z.object({
            pluginId: z.string(),
            overlay: z.string(),
            name: instanceName,
            config: configSchema.optional(),
          }),
          true,
        ),
      },
      responses: {
        201: json(overlayTokenBody, 'The new instance and its token'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    (c) => {
      requireRole(c, 'owner');
      const { pluginId, overlay, name, config: instanceConfig = {} } = c.req.valid('json');
      checkConfig(pluginId, overlay, instanceConfig);
      const { instance, token } = overlays.create(pluginId, overlay, name, instanceConfig);
      return c.json({ instance, token, url: overlayUrl(instance, token) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/overlays/{id}',
      tags: ['overlays'],
      summary: 'Rename an overlay instance and/or replace its config',
      description: `${OWNER} Changing the config needs the plugin running; renaming does not. Open overlays get the new config at once (WebSocket overlay.config).`,
      security: SECURITY,
      request: {
        params: instanceParams,
        body: jsonBody(
          z
            .object({ name: instanceName.optional(), config: configSchema.optional() })
            .refine(
              (body) => body.name !== undefined || body.config !== undefined,
              'Send a name, a config or both',
            ),
          true,
        ),
      },
      responses: {
        200: json(overlayInstanceBody, 'The updated instance'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    (c) => {
      requireRole(c, 'owner');
      const instance = findInstance(c.req.valid('param').id);
      const { name, config: instanceConfig } = c.req.valid('json');
      if (instanceConfig !== undefined) {
        checkConfig(instance.pluginId, instance.overlay, instanceConfig);
      }
      const updated = overlays.update(instance.id, {
        ...(name === undefined ? {} : { name }),
        ...(instanceConfig === undefined ? {} : { config: instanceConfig }),
      });
      if (!updated) {
        throw new ApiError(404, 'not_found', `Unknown overlay instance "${instance.id}"`);
      }
      return c.json(updated, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/overlays/{id}',
      tags: ['overlays'],
      summary: 'Revoke an overlay instance',
      description: `${OWNER} Its token stops working and open overlay sockets close with 4003.`,
      security: SECURITY,
      request: { params: instanceParams },
      responses: { 204: { description: 'Revoked' }, ...errors(401, 403, 404) },
    }),
    (c) => {
      requireRole(c, 'owner');
      const { id } = c.req.valid('param');
      if (!overlays.revoke(id))
        throw new ApiError(404, 'not_found', `Unknown overlay instance "${id}"`);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/overlays/{id}/rotate',
      tags: ['overlays'],
      summary: "Replace an overlay instance's token",
      description: `${OWNER} The old token stops working at once; open overlay sockets close with 4003.`,
      security: SECURITY,
      request: { params: instanceParams },
      responses: {
        200: json(overlayTokenBody, 'The instance and its new token'),
        ...errors(401, 403, 404),
      },
    }),
    (c) => {
      requireRole(c, 'owner');
      const instance = findInstance(c.req.valid('param').id);
      const token = overlays.rotate(instance.id);
      if (token === undefined) {
        throw new ApiError(404, 'not_found', `Unknown overlay instance "${instance.id}"`);
      }
      const rotated = overlays.get(instance.id) ?? instance;
      return c.json({ instance: rotated, token, url: overlayUrl(rotated, token) }, 200);
    },
  );

  // --- event log ---

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/events',
      tags: ['events'],
      summary: 'Recent events for the event inspector',
      description: `${OWNER} Newest first. Includes events that are not exposed to the panel.`,
      security: SECURITY,
      request: {
        query: z.object({
          before: z.string().optional().describe('Only events with a lower id'),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
      responses: { 200: json(eventPageBody, 'A page of events'), ...errors(400, 401, 403) },
    }),
    (c) => {
      requireRole(c, 'owner');
      const { before, limit } = c.req.valid('query');
      return c.json(
        { events: eventLog.list({ limit, ...(before === undefined ? {} : { before }) }) },
        200,
      );
    },
  );

  // --- logs ---

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/logs',
      tags: ['logs'],
      summary: 'Recent log entries for the log view',
      description: `${OWNER} Newest first. Kept in memory: the last 2000 entries at the configured level. Live entries arrive through the WebSocket \`logs\` stream.`,
      security: SECURITY,
      request: {
        query: z.object({
          plugin: z
            .string()
            .optional()
            .describe('Only this plugin; "core" for entries without a plugin'),
          level: z.enum(['debug', 'info', 'warn', 'error']).optional().describe('Minimum level'),
          before: z.coerce.number().int().optional().describe('Only entries with a lower id'),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
      },
      responses: { 200: json(logPageBody, 'A page of log entries'), ...errors(400, 401, 403) },
    }),
    (c) => {
      requireRole(c, 'owner');
      const { plugin, level, before, limit } = c.req.valid('query');
      return c.json(
        {
          entries: deps.logs.list({
            limit,
            ...(plugin === undefined ? {} : { plugin }),
            ...(level === undefined ? {} : { level }),
            ...(before === undefined ? {} : { before }),
          }),
        },
        200,
      );
    },
  );
}
