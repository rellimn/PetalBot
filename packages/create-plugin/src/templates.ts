/**
 * The files of a new plugin, one function each. Deliberately small: the scaffold is a tiny
 * working plugin (one setting, a read and a write RPC, one event, a live widget); the counter
 * (plugins/counter) shows the full set of patterns. The gate test (test/gate.test.ts)
 * typechecks, lints, tests and builds the output, so these can't fall behind the API.
 */
import type { ScaffoldOptions } from './args.ts';
import { member, type PluginNames } from './names.ts';
import { versionOf } from './versions.ts';

export interface TemplateParams extends PluginNames, ScaffoldOptions {}

const GUIDE = 'docs/plugin-guide.md';

const hasUi = (p: TemplateParams): boolean => p.panel || p.overlays.length > 0;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const pick = (names: readonly string[]): Record<string, string> =>
  Object.fromEntries([...names].sort().map((name) => [name, versionOf(name)]));

export function packageJson(p: TemplateParams): string {
  const ui = hasUi(p);
  return json({
    name: `@petalbot-plugin/${p.id}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      build: 'vite build',
      dev: 'vite build --watch',
      typecheck: 'tsc -p tsconfig.json',
      ...(p.db ? { 'db:generate': 'drizzle-kit generate' } : {}),
    },
    petalbot: { id: p.id, apiVersion: 1 },
    dependencies: pick([
      '@petalbot/sdk',
      'zod',
      ...(ui ? ['@petalbot/ui-sdk', 'react'] : []),
      ...(p.db ? ['drizzle-orm'] : []),
    ]),
    devDependencies: pick([
      '@petalbot/testing',
      '@petalbot/tooling',
      'vite',
      ...(ui ? ['@types/react'] : []),
      ...(p.panel ? ['@testing-library/react', '@testing-library/user-event', 'happy-dom'] : []),
      ...(p.db ? ['drizzle-kit'] : []),
    ]),
  });
}

export function tsconfigJson(p: TemplateParams): string {
  return json({
    extends: '@petalbot/tooling/tsconfig/react.json',
    compilerOptions: { types: ['vite/client', 'node'] },
    include: [
      'src',
      'test',
      'vite.config.ts',
      'vitest.config.ts',
      ...(p.db ? ['drizzle.config.ts'] : []),
    ],
  });
}

export const viteConfig =
  (): string => `// One \`vite build\` writes the server entry, the panel and every overlay into dist/, and
// dist/build.json, which tells the core what was built.
import { defineConfig } from 'vite';
import { petalbotPlugin } from '@petalbot/tooling/vite';

export default defineConfig({ plugins: petalbotPlugin() });
`;

export const vitestConfig = (
  p: TemplateParams,
): string => `import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: '${p.id}', include: ['test/**/*.test.{ts,tsx}'] },
});
`;

export const drizzleConfig =
  (): string => `// drizzle-kit's config: where the schema lives and where \`pnpm db:generate\` writes migrations.
// The core applies the migrations from ./drizzle when the plugin starts.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
`;

export function contract(p: TemplateParams): string {
  const overlay = p.overlays.length > 0;
  const widgets = p.panel
    ? `
  // Dashboard widgets. src/panel.tsx implements them; users place them on their dashboards.
  widgets: { presses: {} },
`
    : '';
  const overlays = overlay
    ? `
  // OBS overlays. Each may only use the events and RPCs it lists; the server enforces it.
  overlays: {
${p.overlays
  .map(
    (name) => `    '${name}': {
      config: z.object({ label: z.string().max(40).default('Presses').describe('Shown above the total') }),
      events: ['${p.id}.pressed'],
      rpc: ['${p.id}.status'],
    },`,
  )
  .join('\n')}
  },
`
    : '';
  return `/**
 * The ${p.id} contract: everything other code may know about this plugin.
 *
 * Runs everywhere (the server, the panel and the overlay host), so it imports only zod and
 * @petalbot/sdk, never server code. Names are always qualified ("${p.id}.pressed").
 *
 * Guide: ${GUIDE}#3-the-contract. Read next: src/server.ts.
 */
import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';

export const ${p.camel}Contract = defineContract({
  id: '${p.id}',
  // Must equal the package.json version. A breaking change to this contract is a major bump.
  version: '0.1.0',

  // The panel generates a form for these. Every field needs a default: a fresh install starts
  // without stored settings.
  settings: z.object({
    step: z.number().int().min(1).max(100).default(1).describe('How much one press adds'),
  }),

  events: {
    // Sent after every press, so every open view updates live.
    pressed: {
      schema: z.object({ presses: z.number().int(), by: z.string() }),
      expose: [${overlay ? "'panel', 'overlay'" : "'panel'"}],
    },
  },

  rpc: {
    // A read (kind 'query'): clients get useQuery for it, and src/client.ts keeps it live.
    status: {
      kind: 'query',
      output: z.object({ presses: z.number().int() }),
      expose: { panel: 'mod'${overlay ? ', overlay: true' : ''} },
    },
    // A write (no kind: a mutation): adds the step and answers the new total.
    press: { output: z.object({ presses: z.number().int() }), expose: { panel: 'mod' } },
  },
${widgets}${overlays}});
`;
}

const serverHeader = (p: TemplateParams): string => `/**
 * The ${p.id} server side: its storage, its RPCs and its events.
 *
 * Runs in Node inside the PetalBot core. It may import the contract${p.db ? ', the Drizzle schema' : ''} and Node
 * built-ins; panel and overlay code never import this file.
 *
 * Guide: ${GUIDE}#4-the-server. Read next: ${p.panel ? 'src/client.ts' : 'test/server.test.ts'}.
 */`;

export const kvServer = (p: TemplateParams): string => `${serverHeader(p)}
import { z } from 'zod';
import { definePlugin } from '@petalbot/sdk';
import { ${p.camel}Contract } from './contract.ts';

export default definePlugin(${p.camel}Contract, {
  // KV keys are declared with a schema. Values must survive JSON.
  kv: { presses: z.number().int().min(0) },

  // setup runs on every start. The RPCs it returns become callable once it has finished.
  setup(ctx) {
    return {
      rpc: {
        status: async () => ({ presses: (await ctx.kv.get('presses')) ?? 0 }),

        // who names the caller: the panel user's name, 'overlay', or a plugin id.
        press: async (_input, { who }) => {
          // kv.update reads and writes in one transaction, so two presses at once both count.
          const presses =
            (await ctx.kv.update('presses', (current) => (current ?? 0) + ctx.settings.get().step)) ??
            0;
          // Emit after the write: whoever reacts to the event already sees the new total.
          ctx.emit('${p.id}.pressed', { presses, by: who });
          return { presses };
        },
      },
    };
  },
});
`;

export const dbSchema = (p: TemplateParams): string => `/**
 * The ${p.id} database table, defined with Drizzle.
 *
 * Runs in Node only: the server imports it, the contract and UI code never do. After changing
 * this file, run \`pnpm db:generate --name <change>\` in this folder: drizzle-kit writes a new
 * migration into drizzle/, and the core applies it the next time the plugin starts. Never edit
 * applied migrations; add a new one.
 *
 * Guide: ${GUIDE}#4-the-server. Read next: src/server.ts.
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Table names must start with "${p.id}_". The core refuses anything else.
export const pressLog = sqliteTable('${p.id}_presses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  amount: integer('amount').notNull(),
  by: text('by').notNull(),
  pressedAt: integer('pressed_at', { mode: 'timestamp_ms' }).notNull(),
});
`;

export const dbServer = (p: TemplateParams): string => `${serverHeader(p)}
import { sql } from 'drizzle-orm';
import { definePlugin } from '@petalbot/sdk';
import { ${p.camel}Contract } from './contract.ts';
import { pressLog } from './db/schema.ts';

export default definePlugin(${p.camel}Contract, {
  // Migrations are read from ./drizzle, relative to the plugin folder.
  db: { schema: { pressLog } },

  // setup runs on every start. The RPCs it returns become callable once it has finished.
  setup(ctx) {
    // SQLite's sum() is NULL without rows, hence coalesce.
    const sum = sql<number>\`coalesce(sum(\${pressLog.amount}), 0)\`;

    return {
      rpc: {
        status: () => ({ presses: ctx.db.select({ sum }).from(pressLog).get()?.sum ?? 0 }),

        // who names the caller: the panel user's name, 'overlay', or a plugin id.
        press: (_input, { who }) => {
          // One synchronous transaction: nothing can run between the insert and the sum, and a
          // failure writes nothing.
          const presses = ctx.db.transaction((tx) => {
            tx.insert(pressLog)
              .values({ amount: ctx.settings.get().step, by: who, pressedAt: new Date() })
              .run();
            return tx.select({ sum }).from(pressLog).get()?.sum ?? 0;
          });
          // Emit after the write: whoever reacts to the event already sees the new total.
          ctx.emit('${p.id}.pressed', { presses, by: who });
          return { presses };
        },
      },
    };
  },
});
`;

export const client = (p: TemplateParams): string => `/**
 * The ${p.id} panel client: one typed handle per RPC and event, ${member('api', p.id)}.<member>.
 *
 * Runs in the panel. Created once at module scope: the React Compiler needs the hooks behind it
 * to be the same functions on every render. The contract decides which RPCs are reads
 * (\`kind: 'query'\`); this definition decides, once for every component, how they stay fresh.
 *
 * Guide: ${GUIDE}#5-the-client. Read next: src/panel.tsx.
 */
import { createPluginClient } from '@petalbot/ui-sdk';
import { ${p.camel}Contract } from './contract.ts';

export const api = createPluginClient(${p.camel}Contract, {
  queries: {
    // Patched from the event: a press anywhere shows up without a refetch. \`update\` returns a
    // new object (never mutate), because the cache compares by reference.
    '${p.id}.status': {
      update: { '${p.id}.pressed': (_data, event) => ({ presses: event.payload.presses }) },
    },
  },
  mutations: {
    // The event already updates every view, so a press needs no refetch.
    '${p.id}.press': { invalidates: [] },
  },
});
`;

export function panel(p: TemplateParams): string {
  const api = member('api', p.id);
  const next =
    p.overlays[0] === undefined ? 'test/server.test.ts' : `src/overlays/${p.overlays[0]}.tsx`;
  return `/**
 * The ${p.id} panel: one page and one dashboard widget.
 *
 * Runs in the browser, loaded by the PetalBot panel. It may import the contract, the client and
 * @petalbot/ui-sdk, never server code. Style with ui-sdk components and this file's CSS module
 * (--pb-* tokens, no Tailwind), so it follows the user's color scheme and density.
 *
 * Guide: ${GUIDE}#6-the-panel. Read next: ${next}.
 */
import { Button, Card, Numeric, Spinner, definePanel } from '@petalbot/ui-sdk';
import { api } from './client.ts';
import { ${p.camel}Contract } from './contract.ts';
import styles from './panel.module.css';

/** The total with a Press button, for the page and the widget. */
function Presses() {
  const status = ${api}.status.useQuery();
  // A failed press shows this toast; success needs none, the total changes.
  const press = ${api}.press.useMutation({ error: 'Could not press' });
  if (status.isPending) return <Spinner label="Loading" />;
  return (
    <div className={styles.presses}>
      <span className={styles.value}>
        <Numeric>{status.data?.presses ?? 0}</Numeric>
      </span>
      <Button
        variant="primary"
        loading={press.isPending}
        onClick={() => {
          press.mutate();
        }}
      >
        Press
      </Button>
    </div>
  );
}

function OverviewPage() {
  return (
    <Card title="${p.title}">
      <Presses />
    </Card>
  );
}

export default definePanel(${p.camel}Contract, {
  pages: [{ path: 'overview', title: '${p.title}', minRole: 'mod', component: OverviewPage }],
  // Keys must match the contract's widgets.
  widgets: {
    presses: {
      title: '${p.title}',
      description: 'The total with a Press button',
      minRole: 'mod',
      component: Presses,
    },
  },
});
`;
}

export const panelCss = (): string => `.presses {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--pb-space-3);
}

.value {
  color: var(--pb-accent-text);
  font-family: var(--pb-font-family-display);
  font-size: var(--pb-font-size-xl);
  font-weight: var(--pb-font-weight-bold);
}
`;

export function overlay(p: TemplateParams, name: string): string {
  const client = member('overlay', p.id);
  return `/**
 * The ${name} overlay: the total, for an OBS browser source.
 *
 * Runs in the overlay host, not in the panel: no login and no panel state. Its client may only
 * use what the contract's overlay declaration lists. Overlay bundles are public: never put
 * secrets in them.
 *
 * Guide: ${GUIDE}#7-overlays. Read next: test/server.test.ts.
 */
import {
  createOverlayClient,
  defineOverlay,
  type OverlayConfig,
  type OverlayProps,
} from '@petalbot/ui-sdk';
import { ${p.camel}Contract } from '../contract.ts';
import styles from './${name}.module.css';

const overlay = createOverlayClient(${p.camel}Contract, '${name}', {
  queries: {
    '${p.id}.status': {
      update: { '${p.id}.pressed': (_data, event) => ({ presses: event.payload.presses }) },
    },
  },
});

function Display({ config }: OverlayProps<OverlayConfig<typeof ${p.camel}Contract, '${name}'>>) {
  const status = ${client}.status.useQuery();
  // Nothing while loading: OBS shows a transparent page.
  if (!status.data) return null;
  return (
    <div className={styles.overlay}>
      <span className={styles.label}>{config.label}</span>
      <span className={styles.value}>{status.data.presses}</span>
    </div>
  );
}

export default defineOverlay(${p.camel}Contract, '${name}', { component: Display });
`;
}

export const overlayCss = (): string => `.overlay {
  display: inline-flex;
  align-items: baseline;
  gap: var(--pb-space-3);
  margin: var(--pb-space-4);
  padding: var(--pb-space-3) var(--pb-space-4);
  border-radius: var(--pb-radius-lg);
  background: var(--pb-surface-2);
  color: var(--pb-text);
  font-variant-numeric: tabular-nums;
}

.label {
  color: var(--pb-text-muted);
  font-weight: var(--pb-font-weight-medium);
}

.value {
  font-family: var(--pb-font-family-display);
  font-size: var(--pb-font-size-xl);
  font-weight: var(--pb-font-weight-bold);
}
`;

export const serverTest = (p: TemplateParams): string => `/**
 * Server tests. createTestHarness (@petalbot/testing) runs the plugin in a real PetalBot core on
 * an in-memory database${p.db ? ', with the real migrations from drizzle/' : ''}. \`harness.call\` calls RPCs the way another
 * plugin would, and \`harness.events\` records every event.
 *
 * Guide: ${GUIDE}#8-testing.
 */
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@petalbot/testing';
import plugin from '../src/server.ts';

/** The harness calls as a plugin with this id, so it's the events' \`by\`. */
const CALLER = 'petalbot-test-caller';

describe('${p.id}', () => {
  it('adds the step on every press and announces the total', async () => {
    const harness = await createTestHarness(plugin, { settings: { step: 2 } });
    await expect(harness.call('${p.id}.status')).resolves.toEqual({ presses: 0 });
    await harness.call('${p.id}.press');
    await expect(harness.call('${p.id}.press')).resolves.toEqual({ presses: 4 });
    await harness.idle();
    expect(harness.events.map((event) => event.payload)).toEqual([
      { presses: 2, by: CALLER },
      { presses: 4, by: CALLER },
    ]);
    await harness.stop();
  });

  it('counts every press when many arrive at once', async () => {
    const harness = await createTestHarness(plugin);
    await Promise.all(Array.from({ length: 50 }, () => harness.call('${p.id}.press')));
    await expect(harness.call('${p.id}.status')).resolves.toEqual({ presses: 50 });
    await harness.stop();
  });

  it('uses a new step as soon as the settings change', async () => {
    const harness = await createTestHarness(plugin);
    await harness.updateSettings({ step: 5 });
    await expect(harness.call('${p.id}.press')).resolves.toEqual({ presses: 5 });
    await harness.stop();
  });
});
`;

export const panelTest = (p: TemplateParams): string => `// @vitest-environment happy-dom
/**
 * Panel test: renderPluginUi (@petalbot/testing/ui) renders the widget against a fake server.
 * \`server.answer\` plays the server's side of an RPC, \`server.emit\` sends an event.
 *
 * Guide: ${GUIDE}#8-testing.
 */
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPluginUi } from '@petalbot/testing/ui';
import panel from '../src/panel.tsx';

const Widget = panel.widgets.find((widget) => widget.id === 'presses')?.component ?? (() => null);

describe('presses widget', () => {
  it('shows the total, presses, and follows presses from elsewhere', async () => {
    const { server } = renderPluginUi(<Widget config={{}} instanceId="w1" />);
    await waitFor(() => {
      expect(server.calls('${p.id}.status')).toHaveLength(1);
    });
    act(() => {
      server.answer('${p.id}.status', { presses: 3 });
    });
    expect(await screen.findByText('3')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Press' }));
    expect(server.calls('${p.id}.press')).toHaveLength(1);
    act(() => {
      server.emit('${p.id}.pressed', { presses: 4, by: 'Tester' });
    });
    expect(await screen.findByText('4')).toBeTruthy();
  });
});
`;
