import { isDeepStrictEqual } from 'node:util';

/** True if `value` comes back unchanged from a JSON round trip. */
export const isJsonSafe = (value: unknown): boolean => {
  try {
    // Typed as string, but returns undefined for functions, symbols and undefined.
    const json = JSON.stringify(value) as string | undefined;
    return json !== undefined && isDeepStrictEqual(JSON.parse(json), value);
  } catch {
    return false;
  }
};
