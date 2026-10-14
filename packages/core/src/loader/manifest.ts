import semver from 'semver';
import { z } from 'zod';

export const SUPPORTED_API_VERSIONS: readonly number[] = [1];
/** Ids that would collide with core names (`petalbot_*` tables, the `core` namespace). */
export const RESERVED_IDS: readonly string[] = ['core', 'petalbot'];

const idSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'must match ^[a-z][a-z0-9-]*$')
  .refine((id) => !RESERVED_IDS.includes(id), 'is reserved');

const rangeSchema = z
  .string()
  .refine((range) => semver.validRange(range) !== null, 'must be a semver range');

const dependencyMap = z.record(z.string(), rangeSchema).default({});

export const manifestSchema = z.object({
  id: idSchema,
  apiVersion: z
    .number()
    .int()
    .refine(
      (version) => SUPPORTED_API_VERSIONS.includes(version),
      `is not supported (supported: ${SUPPORTED_API_VERSIONS.join(', ')})`,
    ),
  entries: z.object({
    contract: z.string().optional(),
    server: z.string(),
    panel: z.string().optional(),
    overlays: z.record(z.string(), z.string()).optional(),
  }),
  dependencies: dependencyMap,
  optionalDependencies: dependencyMap,
});

/** The plugin's `package.json`; its `version` is the contract version. */
export const packageSchema = z.object({
  version: z
    .string()
    .refine((version) => semver.valid(version) !== null, 'must be a semver version'),
  petalbot: manifestSchema,
});

export type PluginManifest = z.output<typeof manifestSchema>;
