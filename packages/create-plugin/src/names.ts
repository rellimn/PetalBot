/** Plugin ids and overlay names, as the core accepts them (core: loader/manifest.ts). */
export const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;

/** Ids the core reserves; a test keeps this equal to the core's list. */
export const RESERVED_IDS: readonly string[] = ['core', 'petalbot'];

export interface PluginNames {
  /** The plugin id: "my-plugin". */
  readonly id: string;
  /** For variable names: "myPlugin". */
  readonly camel: string;
  /** For people: "My plugin". */
  readonly title: string;
}

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

export function namesOf(id: string): PluginNames {
  const words = id.split('-').filter((word) => word !== '');
  return {
    id,
    camel: words.map((word, index) => (index === 0 ? word : capitalize(word))).join(''),
    title: capitalize(words.join(' ')),
  };
}

/** `object.id` when the id is an identifier, `object['my-id']` otherwise. */
export function member(object: string, id: string): string {
  return /^[a-z][a-z0-9]*$/.test(id) ? `${object}.${id}` : `${object}['${id}']`;
}
