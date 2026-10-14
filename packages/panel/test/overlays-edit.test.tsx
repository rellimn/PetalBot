import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiError, pluginInfo, renderApp } from './harness.tsx';

const schema = z.toJSONSchema(z.object({ durationMs: z.number().int().min(100).default(5000) }), {
  io: 'input',
  unrepresentable: 'any',
});
const declared = { pluginId: 'alerts', overlay: 'box', schema, hasBundle: true };
const gaming = {
  id: 'a',
  pluginId: 'alerts',
  overlay: 'box',
  name: 'Gaming',
  config: { durationMs: 3000 },
  createdAt: 1,
  rotatedAt: 1,
};
const running = [pluginInfo('alerts', { panel: undefined })];
const stopped = [pluginInfo('alerts', { state: 'disabled', enabled: false, panel: undefined })];

beforeEach(() => {
  localStorage.clear();
});

describe('editing an overlay instance', () => {
  it('renames and saves the config of a running overlay', async () => {
    const harness = await renderApp({
      path: '/admin/overlays/a',
      plugins: running,
      routes: {
        'GET /api/overlays': () => ({ instances: [gaming], overlays: [declared] }),
        'PATCH /api/overlays/a': ({ body }) => ({ ...gaming, ...(body as object) }),
      },
    });
    const name = await screen.findByLabelText<HTMLInputElement>('Name');
    expect(name.value).toBe('Gaming');
    const duration = screen.getByLabelText<HTMLInputElement>('Duration ms');
    expect(duration.value).toBe('3000');
    await userEvent.clear(name);
    await userEvent.type(name, 'Just Chatting');
    await userEvent.clear(duration);
    await userEvent.type(duration, '4000');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(harness.requests.find((request) => request.method === 'PATCH')).toMatchObject({
      path: '/api/overlays/a',
      body: { name: 'Just Chatting', config: { durationMs: 4000 } },
    });
  });

  it('keeps config values the form cannot edit when saving', async () => {
    const richSchema = z.toJSONSchema(
      z.object({
        durationMs: z.number().int().default(5000),
        colors: z.array(z.object({ hex: z.string() })).default([]),
      }),
      { io: 'input', unrepresentable: 'any' },
    );
    const rich = { ...gaming, config: { durationMs: 3000, colors: [{ hex: '#ff0000' }] } };
    const harness = await renderApp({
      path: '/admin/overlays/a',
      plugins: running,
      routes: {
        'GET /api/overlays': () => ({
          instances: [rich],
          overlays: [{ ...declared, schema: richSchema }],
        }),
        'PATCH /api/overlays/a': ({ body }) => ({ ...rich, ...(body as object) }),
      },
    });
    const name = await screen.findByLabelText<HTMLInputElement>('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(harness.requests.find((request) => request.method === 'PATCH')?.body).toEqual({
      name: 'Renamed',
      config: { durationMs: 3000, colors: [{ hex: '#ff0000' }] },
    });
  });

  it('maps validation errors onto the name and config fields', async () => {
    await renderApp({
      path: '/admin/overlays/a',
      plugins: running,
      routes: {
        'GET /api/overlays': () => ({ instances: [gaming], overlays: [declared] }),
        'PATCH /api/overlays/a': () =>
          apiError(400, 'validation', 'Invalid', {
            issues: [
              { path: ['name'], message: 'Too big: expected string to have <=40 characters' },
              { path: ['config', 'durationMs'], message: 'Too small: expected number to be >=100' },
              { path: ['config'], message: 'Something about the whole config' },
            ],
          }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Too big: expected string to have <=40 characters'),
    ).toBeTruthy();
    expect(screen.getByText('Too small: expected number to be >=100')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Something about the whole config');
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('only renames instances of stopped plugins and says why', async () => {
    const harness = await renderApp({
      path: '/admin/overlays/a',
      plugins: stopped,
      routes: {
        'GET /api/overlays': () => ({ instances: [gaming], overlays: [] }),
        'PATCH /api/overlays/a': ({ body }) => ({ ...gaming, ...(body as object) }),
      },
    });
    expect(
      await screen.findByText(
        'alerts is not running. The configuration and the preview are available while it runs.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Duration ms')).toBeNull();
    expect(screen.queryByTitle('Preview of Gaming')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(harness.requests.find((request) => request.method === 'PATCH')?.body).toEqual({
      name: 'Gaming',
    });
  });

  it('previews the instance in a transparent iframe and remembers the toggles', async () => {
    await renderApp({
      path: '/admin/overlays/a',
      plugins: running,
      routes: { 'GET /api/overlays': () => ({ instances: [gaming], overlays: [declared] }) },
    });
    const frame = await screen.findByTitle<HTMLIFrameElement>('Preview of Gaming');
    expect(frame.getAttribute('src')).toBe('/overlay/alerts/box/a?preview');
    expect(frame.style.colorScheme).toBe('normal');
    expect(frame.style.width).toBe('1920px');
    await userEvent.selectOptions(screen.getByLabelText('Aspect'), '9:16');
    await userEvent.selectOptions(screen.getByLabelText('Background'), 'dark');
    expect(frame.style.width).toBe('1080px');
    expect(JSON.parse(localStorage.getItem('petalbot.overlay-preview') ?? 'null')).toEqual({
      aspect: '9:16',
      backdrop: 'dark',
    });
  });

  it('starts the preview with the remembered toggles', async () => {
    localStorage.setItem(
      'petalbot.overlay-preview',
      JSON.stringify({ aspect: '4:3', backdrop: 'light' }),
    );
    await renderApp({
      path: '/admin/overlays/a',
      plugins: running,
      routes: { 'GET /api/overlays': () => ({ instances: [gaming], overlays: [declared] }) },
    });
    expect((await screen.findByLabelText<HTMLSelectElement>('Aspect')).value).toBe('4:3');
    expect(screen.getByLabelText<HTMLSelectElement>('Background').value).toBe('light');
  });

  it('warns when the plugin has no built bundle for the overlay', async () => {
    await renderApp({
      path: '/admin/overlays/a',
      plugins: running,
      routes: {
        'GET /api/overlays': () => ({
          instances: [gaming],
          overlays: [{ ...declared, hasBundle: false }],
        }),
      },
    });
    expect(
      await screen.findByText(
        'alerts has no built bundle for this overlay, so it shows nothing. Build the plugin.',
      ),
    ).toBeTruthy();
  });
});
