import { isAbsolute, relative } from 'node:path';

/** True if `child` lies strictly below `parent` (both absolute, ideally real paths). */
export function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}
