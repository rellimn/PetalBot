/** Splits `'quotes.added'` into `['quotes', 'added']`; undefined for malformed names. */
export function splitName(name: string): readonly [owner: string, member: string] | undefined {
  const dot = name.indexOf('.');
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return [name.slice(0, dot), name.slice(dot + 1)];
}

export function ownerOf(name: string): string | undefined {
  return splitName(name)?.[0];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
