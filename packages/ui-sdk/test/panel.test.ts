import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';
import { checkPanelDefinition, definePanel } from '../src/panel.ts';

const contract = defineContract({
  id: 'quotes',
  version: '1.0.0',
  widgets: { w: {}, configured: { config: z.object({ size: z.number().default(1) }) } },
});
const Page = () => null;

describe('definePanel', () => {
  it('fills defaults, takes widget configs from the contract and passes checkPanelDefinition', () => {
    const panel = definePanel(contract, {
      pages: [{ path: 'list', title: 'Quotes', component: Page }],
      widgets: {
        w: { title: 'W', component: Page },
        configured: { title: 'C', component: Page },
      },
    });
    expect(panel).toEqual({
      kind: 'petalbot.panel',
      pluginId: 'quotes',
      pages: [{ path: 'list', title: 'Quotes', component: Page }],
      widgets: [
        { id: 'w', title: 'W', component: Page },
        {
          id: 'configured',
          title: 'C',
          component: Page,
          config: contract.widgets.configured.config,
        },
      ],
    });
    expect(checkPanelDefinition(panel, 'quotes')).toBe(panel);
  });

  it('refuses widgets that do not match the contract', () => {
    expect(() =>
      definePanel(contract, { widgets: { w: { title: 'W', component: Page } } } as never),
    ).toThrow(
      'Widget "configured" is declared in contract "quotes" but definePanel has no entry for it',
    );
    expect(() =>
      definePanel(contract, {
        widgets: {
          w: { title: 'W', component: Page },
          configured: { title: 'C', component: Page },
          extra: { title: 'X', component: Page },
        },
      } as never),
    ).toThrow('definePanel has widget "extra", which contract "quotes" does not declare');
  });

  it('explains what is wrong with a bundle export', () => {
    const cases: [unknown, string][] = [
      [undefined, 'must default-export definePanel'],
      [{ kind: 'petalbot.panel', pluginId: 'chat', pages: [], widgets: [] }, 'belongs to "chat"'],
      [
        definePanel(contract, {
          pages: [{ path: 'Bad Path', title: 'x', component: Page }],
          widgets: {
            w: { title: 'W', component: Page },
            configured: { title: 'C', component: Page },
          },
        }),
        'Invalid page path "Bad Path"',
      ],
      [
        definePanel(contract, {
          pages: [
            { path: 'a', title: 'A', component: Page },
            { path: 'a', title: 'B', component: Page },
          ],
          widgets: {
            w: { title: 'W', component: Page },
            configured: { title: 'C', component: Page },
          },
        }),
        'Duplicate page path "a"',
      ],
      [
        definePanel(contract, {
          widgets: {
            w: { title: 'W', component: 'nope' as never },
            configured: { title: 'C', component: Page },
          },
        }),
        'Widget "w" has no component',
      ],
      [
        definePanel(contract, {
          widgets: {
            w: { title: 'W', minRole: 'viewer' as never, component: Page },
            configured: { title: 'C', component: Page },
          },
        }),
        'Widget "w" has an unknown minRole',
      ],
      [
        {
          kind: 'petalbot.panel',
          pluginId: 'quotes',
          pages: [],
          widgets: [{ id: 'w', title: 'W', component: Page, config: {} }],
        },
        'Widget "w" has a config that is not a zod object',
      ],
      [
        {
          kind: 'petalbot.panel',
          pluginId: 'quotes',
          pages: [],
          widgets: [{ id: 'w', title: 'W', component: Page, configure: 'x' }],
        },
        'Widget "w" has a configure entry that is not a component',
      ],
    ];
    for (const [value, message] of cases) {
      expect(() => checkPanelDefinition(value, 'quotes')).toThrow(message);
    }
  });
});
