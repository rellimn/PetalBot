import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { defineContract } from '@petalbot/sdk';
import { definePanel } from '@petalbot/ui-sdk';
import { pluginInfo, renderApp } from './harness.tsx';

const queue = definePanel(
  defineContract({ id: 'queue', version: '1.0.0', widgets: { list: {}, stats: {} } }),
  {
    widgets: {
      list: { title: 'Queue', minRole: 'mod', component: () => <p>queue widget</p> },
      stats: {
        title: 'Queue stats',
        description: 'Waiting times',
        component: () => <p>stats widget</p>,
      },
    },
  },
);
const timer = definePanel(
  defineContract({ id: 'timer', version: '1.0.0', widgets: { clock: {} } }),
  {
    widgets: { clock: { title: 'Timer', minRole: 'mod', component: () => <p>12:30</p> } },
  },
);
const live = {
  id: 'p1',
  name: 'Live',
  columns: [
    { width: 70, widgets: [{ id: 'queue/list', plugin: 'queue', widget: 'list' }] },
    { width: 30, widgets: [{ id: 'timer/clock', plugin: 'timer', widget: 'clock' }] },
  ],
  createdAt: 1,
  updatedAt: 1,
};

async function editLive() {
  const harness = await renderApp({
    path: '/',
    plugins: [pluginInfo('queue'), pluginInfo('timer')],
    panels: { queue, timer },
    routes: {
      'GET /api/me/presets': () => ({ presets: [live] }),
      'PUT /api/me/presets/p1': ({ body }) => ({ ...live, ...(body as object) }),
    },
  });
  await screen.findByText('queue widget');
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByRole('toolbar', { name: 'Edit preset' })).toBeTruthy();
  return harness;
}

const lastPut = (harness: Awaited<ReturnType<typeof renderApp>>) =>
  harness.requests
    .filter((request) => request.method === 'PUT' && request.path === '/api/me/presets/p1')
    .at(-1);

describe('editing a preset', () => {
  it('moves, removes and adds widgets, then saves', async () => {
    const harness = await editLive();
    await userEvent.click(screen.getByRole('button', { name: 'Move Queue' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Move right' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Timer' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a widget' });
    expect(within(dialog).getByText('Waiting times')).toBeTruthy();
    await userEvent.selectOptions(within(dialog).getByLabelText('Column'), '0');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Queue stats' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(lastPut(harness)?.body).toEqual({
        name: 'Live',
        columns: [
          {
            width: 70,
            widgets: [{ id: expect.any(String) as string, plugin: 'queue', widget: 'stats' }],
          },
          { width: 30, widgets: [{ id: 'queue/list', plugin: 'queue', widget: 'list' }] },
        ],
      });
    });
    expect(await screen.findByText('stats widget')).toBeTruthy();
    expect(screen.queryByRole('toolbar', { name: 'Edit preset' })).toBeNull();
  });

  it('adds, resizes and removes columns, and renames', async () => {
    const harness = await editLive();
    await userEvent.click(screen.getByRole('button', { name: 'Add column' }));
    const separator = screen.getByRole('separator', { name: 'Resize columns 1 and 2' });
    separator.focus();
    expect(separator.getAttribute('aria-valuenow')).toBe('47');
    await userEvent.keyboard('{ArrowRight}');
    expect(separator.getAttribute('aria-valuenow')).toBe('49');
    await userEvent.click(screen.getByRole('button', { name: 'Remove column 3' }));
    const name = screen.getByLabelText('Preset name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Live big');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(lastPut(harness)?.body).toEqual({
        name: 'Live big',
        columns: [
          { width: 49, widgets: [{ id: 'queue/list', plugin: 'queue', widget: 'list' }] },
          { width: 51, widgets: [{ id: 'timer/clock', plugin: 'timer', widget: 'clock' }] },
        ],
      });
    });
  });

  it('discards changes on Cancel', async () => {
    const harness = await editLive();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Queue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('queue widget')).toBeTruthy();
    expect(lastPut(harness)).toBeUndefined();
  });
});
