import { Quote } from 'lucide-react';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { Choices, choice, defineContract, type NoMembers } from '@petalbot/sdk';
import {
  definePanel,
  type SettingsFormProps,
  type WidgetConfigureProps,
  type WidgetProps,
} from '../src/panel.ts';

const quotes = defineContract({
  id: 'quotes',
  version: '1.0.0',
  settings: z.object({ limit: z.number().int().default(10) }),
  rpc: { options: { kind: 'query', output: Choices, expose: { panel: 'mod' } } },
  widgets: {
    latest: {},
    one: { config: z.object({ quote: choice('quotes.options'), big: z.boolean().default(false) }) },
  },
});

function Latest({ config, instanceId }: WidgetProps<typeof quotes, 'latest'>) {
  expectTypeOf(config).toEqualTypeOf<NoMembers>();
  expectTypeOf(instanceId).toEqualTypeOf<string>();
  return null;
}
function One({ config }: WidgetProps<typeof quotes, 'one'>) {
  expectTypeOf(config).toEqualTypeOf<{ quote: string; big: boolean }>();
  return null;
}
function ConfigureOne({ config, save }: WidgetConfigureProps<typeof quotes, 'one'>) {
  expectTypeOf(config).toEqualTypeOf<{ quote: string; big: boolean } | undefined>();
  void save({ quote: 'a' });
  return null;
}
function Settings({ values, save }: SettingsFormProps<typeof quotes>) {
  expectTypeOf(values).toEqualTypeOf<{ limit: number }>();
  void save({ limit: 3 });
  // @ts-expect-error -- limit is a number
  void save({ limit: 'x' });
  return null;
}

describe('definePanel', () => {
  it('takes one entry per contract widget, typed props and a typed settings form', () => {
    definePanel(quotes, {
      pages: [
        { path: 'list', title: 'Quotes', icon: Quote, minRole: 'mod', component: () => null },
      ],
      widgets: {
        latest: { title: 'Latest quote', component: Latest },
        one: { title: 'Quote', component: One, configure: ConfigureOne },
      },
      settings: Settings,
    });
  });

  it('rejects missing, unknown and mistyped widgets', () => {
    definePanel(quotes, {
      // @ts-expect-error -- one is missing
      widgets: { latest: { title: 'Latest', component: Latest } },
    });
    definePanel(quotes, {
      widgets: {
        latest: { title: 'Latest', component: Latest },
        one: { title: 'Quote', component: One },
        // @ts-expect-error -- not declared in the contract
        extra: { title: 'Extra', component: Latest },
      },
    });
    definePanel(quotes, {
      widgets: {
        // @ts-expect-error -- component props belong to another widget
        latest: { title: 'Latest', component: One },
        one: { title: 'Quote', component: One },
      },
    });
    definePanel(quotes, {
      // @ts-expect-error -- not a role
      pages: [{ path: 'list', title: 'Quotes', minRole: 'viewer', component: () => null }],
    });
  });
});
