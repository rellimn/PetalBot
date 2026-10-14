import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { isInside } from '../../fs-paths.ts';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

export function contentType(fileName: string): string {
  return CONTENT_TYPES[extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

/** Decoded path segments of a URL path; undefined if any segment is unsafe. */
export function safeSegments(encoded: readonly string[]): string[] | undefined {
  const segments: string[] = [];
  for (const part of encoded) {
    let segment: string;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return undefined;
    }
    if (segment === '' || segment === '.' || segment === '..' || /[/\\\0]/.test(segment)) {
      return undefined;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments : undefined;
}

/** Reads a regular file below `root`; undefined for anything that escapes it or isn't a file. */
export async function readFileInside(
  root: string,
  segments: readonly string[],
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const realRoot = await realpath(root).catch(() => undefined);
  if (realRoot === undefined) return undefined;
  const file = await realpath(join(realRoot, ...segments)).catch(() => undefined);
  if (file === undefined || !isInside(realRoot, file)) return undefined;
  const info = await stat(file);
  if (!info.isFile()) return undefined;
  return new Uint8Array(await readFile(file));
}
