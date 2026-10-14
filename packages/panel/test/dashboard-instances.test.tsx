import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Choices, choice, defineContract } from '@petalbot/sdk';
import { createPluginClient, definePanel } from '@petalbot/ui-sdk';
import { pluginInfo, renderApp } from './harness.tsx';

const counterContract = defineContract({
  id: 'counter',
  version: '1.0.0',
  events: { listChanged: { schema: z.object({}), expose: ['panel'] } },
  rpc: { options: { output: Choices, expose: { panel: 'mod' } } },
  widgets: {
    value: { config: z.object({ counter: choice('counter.options').describe('Counter') }) },
    total: {},
  },
});
const counterPanel = definePanel(counterContract, {
  widgets: {
    value: {
      title: 'Counter',
      component: ({ config, instanceId }) => (
        <p>
          value of {config.counter} ({instanceId})
        </p>
      ),
    },
    total: { title: 'Total', component: () => <p>total widget</p> },
  },
});
// The plugin's own client declares how its choices stay fresh; the panel reuses that definition.
createPluginClient(counterContract, {
  queries: { 'counter.options': { refreshOn: ['counter.listChanged'] } },
});
const choices = [
  { value: 'a', label: 'Deaths' },
  { value: 'b', label: 'Wins' },
];
const preset = (widgets: readonly object[]) => ({
  id: 'p1',
  name: 'Live',
  columns: [{ width: 100, widgets }],
  createdAt: 1,
  updatedAt: 1,
});

async function render(widgets: readonly object[]) {
  const harness = await renderApp({
    path: '/',
    plugins: [pluginInfo('counter')],
    panels: { counter: counterPanel },
    routes: {
      'GET /api/me/presets': () => ({ presets: [preset(widgets)] }),
      'PUT /api/me/presets/p1': ({ body }) => ({ ...preset(widgets), ...(body as object) }),
    },
  });
  const answerChoices = async () => {
    await waitFor(() => {
      expect(harness.socket.ofType('rpc').some((m) => m.name === 'counter.options')).toBe(true);
    });
    act(() => {
      harness.socket.answer('rpc', choices, (message) => message.name === 'counter.options');
    });
  };
  const lastPut = () => harness.requests.filter((request) => request.method === 'PUT').at(-1)?.body;
  return { harness, answerChoices, lastPut };
}

describe('widget instances', () => {
  it('places the same widget twice with different configs', async () => {
    const { answerChoices, lastPut } = await render([]);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    for (const pick of ['a', 'b']) {
      await userEvent.click(screen.getByRole('button', { name: 'Add widget' }));
      const add = await screen.findByRole('dialog', { name: 'Add a widget' });
      await userEvent.click(within(add).getByRole('button', { name: 'Add Counter' }));
      const configure = await screen.findByRole('dialog', { name: 'Configure Counter' });
      if (pick === 'a') await answerChoices();
      const select = await within(configure).findByLabelText<HTMLSelectElement>('Counter');
      await waitFor(() => {
        expect(select.disabled).toBe(false);
      });
      await userEvent.selectOptions(select, pick);
      await userEvent.click(within(configure).getByRole('button', { name: 'Save' }));
    }
    await userEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    const add = await screen.findByRole('dialog', { name: 'Add a widget' });
    await userEvent.click(within(add).getByRole('button', { name: 'Add Total' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(lastPut()).toEqual({
        name: 'Live',
        columns: [
          {
            width: 100,
            widgets: [
              {
                id: expect.any(String) as string,
                plugin: 'counter',
                widget: 'value',
                config: { counter: 'a' },
              },
              {
                id: expect.any(String) as string,
                plugin: 'counter',
                widget: 'value',
                config: { counter: 'b' },
              },
              { id: expect.any(String) as string, plugin: 'counter', widget: 'total' },
            ],
          },
        ],
      });
    });
    const ids = (lastPut() as { columns: { widgets: { id: string }[] }[] }).columns[0]?.widgets.map(
      (widget) => widget.id,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it('shows Needs configuration for a stored config that no longer parses, and fixes it', async () => {
    const { answerChoices, lastPut } = await render([
      { id: 'i1', plugin: 'counter', widget: 'value', config: {} },
    ]);
    expect(await screen.findByText('Needs configuration')).toBeTruthy();
    expect(screen.queryByText(/value of/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Configure' }));
    const configure = await screen.findByRole('dialog', { name: 'Configure Counter' });
    await answerChoices();
    const select = await within(configure).findByLabelText<HTMLSelectElement>('Counter');
    await waitFor(() => {
      expect(select.disabled).toBe(false);
    });
    await userEvent.selectOptions(select, 'a');
    await userEvent.click(within(configure).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(lastPut()).toMatchObject({
        columns: [{ widgets: [{ id: 'i1', config: { counter: 'a' } }] }],
      });
    });
    expect(await screen.findByText('value of a (i1)')).toBeTruthy();
  });

  it('suffixes the frame title with the choice label', async () => {
    const { answerChoices } = await render([
      { id: 'i1', plugin: 'counter', widget: 'value', config: { counter: 'a' } },
      { id: 'i2', plugin: 'counter', widget: 'value', config: { counter: 'gone' } },
    ]);
    await answerChoices();
    expect(await screen.findByText('Counter · Deaths')).toBeTruthy();
    expect(screen.getByText('Counter · (deleted)')).toBeTruthy();
    expect(screen.getByText('value of a (i1)')).toBeTruthy();
    expect(screen.getByText('value of gone (i2)')).toBeTruthy();
  });

  it('reconfigures a placed widget in edit mode', async () => {
    const { answerChoices, lastPut } = await render([
      { id: 'i1', plugin: 'counter', widget: 'value', config: { counter: 'a' } },
    ]);
    await answerChoices();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Configure Counter' }));
    const configure = await screen.findByRole('dialog', { name: 'Configure Counter' });
    const select = await within(configure).findByLabelText<HTMLSelectElement>('Counter');
    expect(select.value).toBe('a');
    await userEvent.selectOptions(select, 'b');
    await userEvent.click(within(configure).getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(lastPut()).toMatchObject({
        columns: [{ widgets: [{ id: 'i1', config: { counter: 'b' } }] }],
      });
    });
  });

  it("keeps the title's choice label live with the plugin's own query definition", async () => {
    const { harness, answerChoices } = await render([
      { id: 'i1', plugin: 'counter', widget: 'value', config: { counter: 'a' } },
    ]);
    await answerChoices();
    expect(await screen.findByText('Counter · Deaths')).toBeTruthy();
    const options = () =>
      harness.socket.ofType('rpc').filter((message) => message.name === 'counter.options');
    act(() => {
      harness.socket.receive({
        type: 'event',
        envelope: {
          id: 'e1',
          name: 'counter.listChanged',
          payload: {},
          source: 'counter',
          timestamp: 1,
          depth: 0,
        },
      });
    });
    await waitFor(() => {
      expect(options()).toHaveLength(2);
    });
    act(() => {
      harness.socket.answer('rpc', [], (message) => message.name === 'counter.options');
    });
    expect(await screen.findByText('Counter · (deleted)')).toBeTruthy();
  });

  it('shows config fields JSON Schema cannot describe as unsupported instead of crashing', async () => {
    const timerContract = defineContract({
      id: 'timer',
      version: '1.0.0',
      widgets: { until: { config: z.object({ at: z.date() }) } },
    });
    const timerPanel = definePanel(timerContract, {
      widgets: { until: { title: 'Countdown', component: () => <p>countdown</p> } },
    });
    await renderApp({
      path: '/',
      plugins: [pluginInfo('timer')],
      panels: { timer: timerPanel },
      routes: { 'GET /api/me/presets': () => ({ presets: [preset([])] }) },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    const add = await screen.findByRole('dialog', { name: 'Add a widget' });
    await userEvent.click(within(add).getByRole('button', { name: 'Add Countdown' }));
    const configure = await screen.findByRole('dialog', { name: 'Configure Countdown' });
    expect(within(configure).getByText(/can.t be edited here/)).toBeTruthy();
  });
});
