import { describe, expect, it } from 'vitest';
import { defineContract } from '@petalbot/sdk';
import { checkPanelDefinition, definePanel } from '../src/panel.ts';

const contract = defineContract({ id: 'quotes', version: '1.0.0' });
const Page = () => null;

describe('definePanel', () => {
  it('fills defaults and passes checkPanelDefinition', () => {
    const panel = definePanel(contract, {
      pages: [{ path: 'list', title: 'Quotes', component: Page }],
    });
    expect(panel).toEqual({
      kind: 'petalbot.panel',
      pluginId: 'quotes',
      pages: [{ path: 'list', title: 'Quotes', component: Page }],
      widgets: [],
    });
    expect(checkPanelDefinition(panel, 'quotes')).toBe(panel);
  });

  it('explains what is wrong with a bundle export', () => {
    const cases: [unknown, string][] = [
      [undefined, 'must default-export definePanel'],
      [{ kind: 'petalbot.panel', pluginId: 'chat', pages: [], widgets: [] }, 'belongs to "chat"'],
      [
        definePanel(contract, { pages: [{ path: 'Bad Path', title: 'x', component: Page }] }),
        'Invalid page path "Bad Path"',
      ],
      [
        definePanel(contract, {
          pages: [
            { path: 'a', title: 'A', component: Page },
            { path: 'a', title: 'B', component: Page },
          ],
        }),
        'Duplicate page path "a"',
      ],
      [
        definePanel(contract, { widgets: [{ id: 'w', title: 'W', component: 'nope' as never }] }),
        'Widget "w" has no component',
      ],
      [
        definePanel(contract, {
          widgets: [{ id: 'w', title: 'W', minRole: 'viewer' as never, component: Page }],
        }),
        'Widget "w" has an unknown minRole',
      ],
    ];
    for (const [value, message] of cases) {
      expect(() => checkPanelDefinition(value, 'quotes')).toThrow(message);
    }
  });
});
