import { parseArgs } from 'node:util';
import { PLUGIN_ID, RESERVED_IDS } from './names.ts';

export interface ScaffoldOptions {
  readonly id: string;
  /** A panel page and a dashboard widget (src/client.ts, src/panel.tsx). */
  readonly panel: boolean;
  /** A Drizzle table instead of KV. */
  readonly db: boolean;
  /** One src/overlays/<name>.tsx each. */
  readonly overlays: readonly string[];
}

export const USAGE = 'Usage: pnpm create-plugin <id> [--no-panel] [--db] [--overlay <name>]…';

function parse(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        'no-panel': { type: 'boolean', default: false },
        db: { type: 'boolean', default: false },
        overlay: { type: 'string', multiple: true, default: [] },
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\n${USAGE}`, { cause: error });
  }
}

function checkName(what: string, name: string): void {
  if (!PLUGIN_ID.test(name)) {
    throw new Error(
      `Invalid ${what} "${name}": use lowercase letters, digits and dashes, starting with a letter`,
    );
  }
}

/** Reads `<id> [--no-panel] [--db] [--overlay <name>]…`. Throws an Error with a readable message. */
export function parseCreateArgs(argv: readonly string[]): ScaffoldOptions {
  const { values, positionals } = parse(argv);
  const [id, ...extra] = positionals;
  if (id === undefined || extra.length > 0) throw new Error(USAGE);
  checkName('plugin id', id);
  if (RESERVED_IDS.includes(id)) throw new Error(`The plugin id "${id}" is reserved`);
  const overlays = values.overlay;
  for (const name of overlays) checkName('overlay name', name);
  const duplicate = overlays.find((name, index) => overlays.indexOf(name) !== index);
  if (duplicate !== undefined) throw new Error(`The overlay "${duplicate}" is listed twice`);
  return { id, panel: !values['no-panel'], db: values.db, overlays };
}
