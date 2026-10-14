import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { isInside } from '../fs-paths.ts';
import { errorMessage } from '../names.ts';

/** Written by `petalbotPlugin()` after every complete build (same path as @petalbot/tooling's). */
export const BUILD_MARKER = join('dist', 'build.json');

/** A plugin's built entries, relative to its folder. */
export interface PluginEntries {
  readonly server: string;
  readonly panel?: string;
  readonly overlays: Readonly<Record<string, string>>;
}

const markerSchema = z.object({
  builtAt: z.number(),
  entries: z.object({
    server: z.string().min(1).optional(),
    panel: z.string().min(1).optional(),
    overlays: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.string().min(1)),
  }),
});

const BUILD = '"pnpm build" in the plugin folder, or "pnpm dev"';

/** Reads `<dir>/dist/build.json` without running plugin code. */
export async function readBuildInfo(
  dir: string,
): Promise<PluginEntries | { readonly message: string }> {
  let raw: string;
  try {
    raw = await readFile(join(dir, BUILD_MARKER), 'utf8');
  } catch {
    return { message: `Not built: dist/build.json is missing (build it with ${BUILD})` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      message: `Not built: dist/build.json is invalid (${errorMessage(error)}); rebuild it with ${BUILD}`,
    };
  }
  const parsed = markerSchema.safeParse(json);
  if (!parsed.success) {
    return {
      message: `Not built: dist/build.json is invalid (${z.prettifyError(parsed.error)}); rebuild it with ${BUILD}`,
    };
  }
  const { server, panel, overlays } = parsed.data.entries;
  if (server === undefined) {
    return {
      message: 'Not built: dist/build.json names no server entry (is src/server.ts missing?)',
    };
  }
  for (const entry of [
    server,
    ...(panel === undefined ? [] : [panel]),
    ...Object.values(overlays),
  ]) {
    if (!isInside(dir, resolve(dir, entry))) {
      return { message: `dist/build.json: the entry ${entry} is outside the plugin folder` };
    }
  }
  return { server, ...(panel === undefined ? {} : { panel }), overlays };
}
