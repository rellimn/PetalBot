import { ApiError } from '@petalbot/ui-sdk';
import { fieldPaths, type FieldSpec } from '../settings/schema.ts';

export interface FormErrors {
  readonly name?: string;
  /** 'a.b' (config-relative) -> message */
  readonly config: ReadonlyMap<string, string>;
  /** Issues that belong to no field. */
  readonly form?: string;
}

export const NO_ERRORS: FormErrors = { config: new Map() };

/**
 * Validation issues of POST/PATCH /api/overlays mapped onto the name and config fields (paths are
 * body-relative: ['name'] or ['config', …]). Undefined for every other error.
 */
export function formErrors(error: unknown, fields: readonly FieldSpec[]): FormErrors | undefined {
  if (!(error instanceof ApiError) || error.code !== 'validation') return undefined;
  const known = new Set(fieldPaths(fields));
  let name: string | undefined;
  const config = new Map<string, string>();
  const other: string[] = [];
  for (const issue of error.issues) {
    const [head, ...rest] = issue.path.map(String);
    const path = rest.join('.');
    if (head === 'name' && rest.length === 0) name = issue.message;
    else if (head === 'config' && known.has(path)) config.set(path, issue.message);
    else other.push(issue.message);
  }
  if (error.issues.length === 0) other.push(error.message);
  return {
    ...(name === undefined ? {} : { name }),
    config,
    ...(other.length > 0 ? { form: other.join(' ') } : {}),
  };
}
