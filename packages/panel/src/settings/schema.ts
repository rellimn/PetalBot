type Json = Readonly<Record<string, unknown>>;

interface FieldBase {
  readonly key: string;
  /** From the settings root, e.g. ['limits', 'perMinute']; matches zod issue paths. */
  readonly path: readonly string[];
  readonly label: string;
  readonly help?: string;
  readonly required: boolean;
  readonly hasDefault: boolean;
}

export type FieldSpec =
  | (FieldBase & {
      readonly kind: 'string';
      readonly format?: string;
      readonly minLength?: number;
      readonly maxLength?: number;
    })
  | (FieldBase & {
      readonly kind: 'number';
      readonly integer: boolean;
      readonly minimum?: number;
      readonly maximum?: number;
    })
  | (FieldBase & { readonly kind: 'boolean' })
  | (FieldBase & { readonly kind: 'enum'; readonly options: readonly (string | number)[] })
  | (FieldBase & { readonly kind: 'list'; readonly item: 'string' | 'number' | 'integer' })
  | (FieldBase & { readonly kind: 'object'; readonly fields: readonly FieldSpec[] })
  | (FieldBase & { readonly kind: 'unsupported'; readonly reason: string });

export type FormValues = Readonly<Record<string, unknown>>;

export const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A number limit, or undefined (zod adds ±MAX_SAFE_INTEGER to every int). */
const limit = (value: unknown): number | undefined =>
  typeof value === 'number' && Math.abs(value) < Number.MAX_SAFE_INTEGER ? value : undefined;

export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Form fields for the supported JSON Schema subset; anything else becomes 'unsupported'. */
export function settingsFields(schema: Json | null): FieldSpec[] {
  if (schema?.type !== 'object') return [];
  return objectFields(schema, []);
}

function objectFields(schema: Json, path: readonly string[]): FieldSpec[] {
  const properties = isJson(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : [],
  );
  return Object.entries(properties).map(([key, value]) =>
    fieldOf(key, isJson(value) ? value : {}, [...path, key], required.has(key)),
  );
}

function fieldOf(key: string, schema: Json, path: readonly string[], required: boolean): FieldSpec {
  const base: FieldBase = {
    key,
    path,
    required,
    hasDefault: 'default' in schema,
    label: typeof schema.title === 'string' ? schema.title : humanize(key),
    ...(typeof schema.description === 'string' ? { help: schema.description } : {}),
  };
  const unsupported = (reason: string): FieldSpec => ({ ...base, kind: 'unsupported', reason });

  if (Array.isArray(schema.enum)) {
    const options = schema.enum.filter(
      (option): option is string | number =>
        typeof option === 'string' || typeof option === 'number',
    );
    return options.length > 0 && options.length === schema.enum.length
      ? { ...base, kind: 'enum', options }
      : unsupported('a choice of other values');
  }
  switch (schema.type) {
    case 'string': {
      const minLength = limit(schema.minLength);
      const maxLength = limit(schema.maxLength);
      return {
        ...base,
        kind: 'string',
        ...(typeof schema.format === 'string' ? { format: schema.format } : {}),
        ...(minLength === undefined ? {} : { minLength }),
        ...(maxLength === undefined ? {} : { maxLength }),
      };
    }
    case 'number':
    case 'integer': {
      const minimum = limit(schema.minimum);
      const maximum = limit(schema.maximum);
      return {
        ...base,
        kind: 'number',
        integer: schema.type === 'integer',
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
      };
    }
    case 'boolean':
      return { ...base, kind: 'boolean' };
    case 'array': {
      const itemType = isJson(schema.items) ? schema.items.type : undefined;
      return itemType === 'string' || itemType === 'number' || itemType === 'integer'
        ? { ...base, kind: 'list', item: itemType }
        : unsupported('a list of complex values');
    }
    case 'object':
      return { ...base, kind: 'object', fields: objectFields(schema, path) };
    default:
      return unsupported(
        Array.isArray(schema.type) || 'anyOf' in schema || 'oneOf' in schema
          ? 'a value of several types'
          : 'an unsupported type',
      );
  }
}

/** A copy of `values` with `value` at `path`; undefined removes the key. */
export function setPath(values: FormValues, path: readonly string[], value: unknown): FormValues {
  const [head, ...rest] = path;
  if (head === undefined) return values;
  const current = values[head];
  const next = rest.length === 0 ? value : setPath(isJson(current) ? current : {}, rest, value);
  const others = Object.entries(values).filter(([key]) => key !== head);
  return Object.fromEntries(next === undefined ? others : [...others, [head, next]]);
}

/** The PATCH body: every editable top-level field that has a value. */
export function patchOf(fields: readonly FieldSpec[], values: FormValues): FormValues {
  return Object.fromEntries(
    fields
      .filter((field) => field.kind !== 'unsupported')
      .map((field) => [field.key, values[field.key]] as const)
      .filter(([, value]) => value !== undefined),
  );
}

/** Every field path as 'a.b', for matching validation issues. */
export function fieldPaths(fields: readonly FieldSpec[]): string[] {
  return fields.flatMap((field) => [
    field.path.join('.'),
    ...(field.kind === 'object' ? fieldPaths(field.fields) : []),
  ]);
}
