import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import type { AppDeps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { PresetLimitError } from '../users/user-store.ts';
import { requireRole, type AppEnv } from './middleware.ts';
import { SECURITY, errors, json } from './responses.ts';
import { preferencesBody, presetBody, presetInputBody, presetListBody } from './schemas.ts';

const MOD = "Minimum role: mod. Only ever the logged-in user's own data.";
const presetParams = z.object({ id: z.string().describe('Preset id') });
const jsonBody = <S extends z.ZodType>(schema: S) => ({
  required: true,
  content: { 'application/json': { schema } },
});

/** The logged-in user's appearance preferences and dashboard presets. */
export function registerMeRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const { users } = deps;
  const missing = (id: string) => new ApiError(404, 'not_found', `Unknown preset "${id}"`);

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/me/preferences',
      tags: ['me'],
      summary: 'Appearance preferences and the active preset',
      description: MOD,
      security: SECURITY,
      responses: { 200: json(preferencesBody, 'The preferences'), ...errors(401, 403) },
    }),
    (c) => {
      const session = requireRole(c, 'mod');
      return c.json(users.preferences(session.user.id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/me/preferences',
      tags: ['me'],
      summary: 'Replace the preferences',
      description: `${MOD} Missing fields take their defaults. activePreset must be one of the user's presets.`,
      security: SECURITY,
      request: { body: jsonBody(preferencesBody) },
      responses: {
        200: json(preferencesBody, 'The saved preferences'),
        ...errors(400, 401, 403),
      },
    }),
    (c) => {
      const session = requireRole(c, 'mod');
      const preferences = c.req.valid('json');
      const active = preferences.activePreset;
      if (active !== null && !users.preset(session.user.id, active)) {
        throw new ApiError(400, 'validation', `Unknown preset "${active}"`);
      }
      return c.json(users.setPreferences(session.user.id, preferences), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/me/presets',
      tags: ['me'],
      summary: "The user's dashboard presets",
      description: `${MOD} Oldest first. An empty list means the panel creates a starter preset.`,
      security: SECURITY,
      responses: { 200: json(presetListBody, 'The presets'), ...errors(401, 403) },
    }),
    (c) => {
      const session = requireRole(c, 'mod');
      return c.json({ presets: users.presets(session.user.id) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/me/presets',
      tags: ['me'],
      summary: 'Create a preset',
      description: `${MOD} At most 20 presets per user (409 conflict).`,
      security: SECURITY,
      request: { body: jsonBody(presetInputBody) },
      responses: {
        201: json(presetBody, 'The new preset'),
        ...errors(400, 401, 403, 409),
      },
    }),
    (c) => {
      const session = requireRole(c, 'mod');
      try {
        return c.json(users.createPreset(session.user.id, c.req.valid('json')), 201);
      } catch (error) {
        if (error instanceof PresetLimitError) throw new ApiError(409, 'conflict', error.message);
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/me/presets/{id}',
      tags: ['me'],
      summary: "Replace a preset's name and layout",
      description: MOD,
      security: SECURITY,
      request: { params: presetParams, body: jsonBody(presetInputBody) },
      responses: {
        200: json(presetBody, 'The updated preset'),
        ...errors(400, 401, 403, 404),
      },
    }),
    (c) => {
      const session = requireRole(c, 'mod');
      const { id } = c.req.valid('param');
      const preset = users.updatePreset(session.user.id, id, c.req.valid('json'));
      if (!preset) throw missing(id);
      return c.json(preset, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/me/presets/{id}',
      tags: ['me'],
      summary: 'Delete a preset',
      description: `${MOD} If it was active, activePreset becomes null.`,
      security: SECURITY,
      request: { params: presetParams },
      responses: { 204: { description: 'Deleted' }, ...errors(401, 403, 404) },
    }),
    (c) => {
      const session = requireRole(c, 'mod');
      const { id } = c.req.valid('param');
      if (!users.deletePreset(session.user.id, id)) throw missing(id);
      return c.body(null, 204);
    },
  );
}
