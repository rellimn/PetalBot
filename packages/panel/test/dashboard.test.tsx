import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { defineContract } from '@petalbot/sdk';
import { definePanel } from '@petalbot/ui-sdk';
import { modUser, pluginInfo, renderApp } from './harness.tsx';

let crash = false;
const queue = definePanel(defineContract({ id: 'queue', version: '1.0.0' }), {
  widgets: [
    {
      id: 'list',
      title: 'Queue',
      minRole: 'mod',
      component: () => {
        if (crash) throw new Error('queue widget broke');
        return <p>queue widget</p>;
      },
    },
    { id: 'stats', title: 'Queue stats', component: () => <p>stats widget</p> },
  ],
});
const timer = definePanel(defineContract({ id: 'timer', version: '1.0.0' }), {
  widgets: [{ id: 'clock', title: 'Timer', minRole: 'mod', component: () => <p>12:30</p> }],
});
const plugins = [pluginInfo('queue'), pluginInfo('timer')];
const panels = { queue, timer };

const preset = (id: string, name: string, widgets: { plugin: string; widget: string }[][]) => ({
  id,
  name,
  columns: widgets.map((column, index) => ({ width: index === 0 ? 70 : 30, widgets: column })),
  createdAt: 1,
  updatedAt: 1,
});
const live = preset('p1', 'Live', [
  [{ plugin: 'queue', widget: 'list' }],
  [{ plugin: 'timer', widget: 'clock' }],
]);
const chill = preset('p2', 'Chill', [[{ plugin: 'timer', widget: 'clock' }]]);

const created = ({ body }: { body: unknown }) => ({
  id: 'new',
  ...(body as object),
  createdAt: 1,
  updatedAt: 1,
});

describe('dashboard', () => {
  it('creates a starter preset with the widgets the user may see', async () => {
    const harness = await renderApp({
      path: '/',
      plugins,
      panels,
      routes: { 'POST /api/me/presets': created },
    });
    expect(await screen.findByText('queue widget')).toBeTruthy();
    expect(screen.getByText('stats widget')).toBeTruthy();
    expect(screen.getByText('12:30')).toBeTruthy();
    expect(harness.requests.filter((request) => request.method === 'POST')).toEqual([
      {
        method: 'POST',
        path: '/api/me/presets',
        body: {
          name: 'My dashboard',
          columns: [
            { width: 70, widgets: [{ plugin: 'queue', widget: 'list' }] },
            {
              width: 30,
              widgets: [
                { plugin: 'queue', widget: 'stats' },
                { plugin: 'timer', widget: 'clock' },
              ],
            },
          ],
        },
      },
    ]);
  });

  it('gives mods a starter preset without owner widgets', async () => {
    const harness = await renderApp({
      path: '/',
      user: modUser,
      plugins,
      panels,
      routes: { 'POST /api/me/presets': created },
    });
    await screen.findByText('queue widget');
    expect(screen.queryByText('stats widget')).toBeNull();
    expect(harness.requests.find((request) => request.method === 'POST')?.body).toMatchObject({
      columns: [{ widgets: [{ widget: 'list' }] }, { widgets: [{ widget: 'clock' }] }],
    });
  });

  it('shows placeholders for widgets of stopped plugins and brings them back', async () => {
    const harness = await renderApp({
      path: '/',
      user: modUser,
      plugins,
      panels,
      routes: { 'GET /api/me/presets': () => ({ presets: [live] }) },
    });
    await screen.findByText('queue widget');
    harness.setPlugin(pluginInfo('queue', { state: 'disabled', enabled: false, panel: undefined }));
    expect(await screen.findByText('Queue — plugin not running')).toBeTruthy();
    expect(screen.getByText('12:30')).toBeTruthy();
    harness.setPlugin(pluginInfo('queue'));
    expect(await screen.findByText('queue widget')).toBeTruthy();
  });

  it('switches presets and remembers the choice', async () => {
    const harness = await renderApp({
      path: '/',
      plugins,
      panels,
      routes: { 'GET /api/me/presets': () => ({ presets: [live, chill] }) },
    });
    await screen.findByText('queue widget');
    await userEvent.selectOptions(screen.getByLabelText('Preset'), 'p2');
    await waitFor(() => {
      expect(screen.queryByText('queue widget')).toBeNull();
    });
    expect(harness.requests.filter((request) => request.method === 'PUT').at(-1)).toMatchObject({
      path: '/api/me/preferences',
      body: { activePreset: 'p2' },
    });
  });

  it('enters focus explicitly, exits with Esc and never restores it', async () => {
    const harness = await renderApp({
      path: '/',
      plugins,
      panels,
      routes: { 'GET /api/me/presets': () => ({ presets: [live] }) },
    });
    await screen.findByText('queue widget');
    await userEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    const strip = screen.getByRole('toolbar', { name: 'Focus mode' });
    expect(within(strip).getByRole('button', { name: 'Exit' })).toBeTruthy();
    expect(screen.getByText('queue widget')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Focus' }));
    act(() => {
      harness.history.push('/admin/plugins');
    });
    act(() => {
      harness.history.push('/');
    });
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeTruthy();
  });

  it('renames, creates and deletes presets', async () => {
    const harness = await renderApp({
      path: '/',
      plugins,
      panels,
      routes: {
        'GET /api/me/presets': () => ({ presets: [live, chill] }),
        'PUT /api/me/presets/p1': ({ body }) => ({ ...live, ...(body as object) }),
        'POST /api/me/presets': created,
        'DELETE /api/me/presets/p1': () => undefined,
      },
    });
    await screen.findByText('queue widget');
    await userEvent.click(screen.getByRole('button', { name: 'Preset actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Live 2{enter}');
    await waitFor(() => {
      expect(harness.requests.at(-1)).toMatchObject({
        method: 'PUT',
        path: '/api/me/presets/p1',
        body: { name: 'Live 2' },
      });
    });

    await userEvent.click(screen.getByRole('button', { name: 'Preset actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'New preset…' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Raid{enter}');
    await waitFor(() => {
      expect(
        harness.requests.some(
          (request) =>
            request.method === 'POST' && (request.body as { name: string }).name === 'Raid',
        ),
      ).toBe(true);
    });

    await userEvent.selectOptions(screen.getByLabelText('Preset'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Preset actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete preset…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(
        harness.requests.some(
          (request) => request.method === 'DELETE' && request.path === '/api/me/presets/p1',
        ),
      ).toBe(true);
    });
  });

  it('contains a crashing widget in its card', async () => {
    crash = true;
    await renderApp({
      path: '/',
      plugins,
      panels,
      routes: { 'GET /api/me/presets': () => ({ presets: [live] }) },
    });
    expect(await screen.findByText(/queue widget broke/)).toBeTruthy();
    expect(screen.getByText('12:30')).toBeTruthy();
    crash = false;
  });
});
