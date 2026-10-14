import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { choice, defineContract } from '@petalbot/sdk';
import { Button, definePanel } from '@petalbot/ui-sdk';
import { apiError, modUser, pluginInfo, renderApp } from './harness.tsx';

const settingsSchema = z.object({
  volume: z.number().min(0).max(100).default(50).describe('How loud alerts play'),
  enabled: z.boolean().default(true),
  mode: z.enum(['chat', 'whisper']).default('chat'),
  greeting: z.string().max(200).optional(),
  banned: z.array(z.string()).default([]),
  limits: z.object({ perMinute: z.number().int().min(1).default(20) }).prefault({}),
  either: z.union([z.string(), z.number()]).optional(),
});
const schema = z.toJSONSchema(settingsSchema, { io: 'input', unrepresentable: 'any' });
const values = {
  volume: 50,
  enabled: true,
  mode: 'chat',
  banned: ['spam'],
  limits: { perMinute: 20 },
  either: 3,
};
const quotes = defineContract({ id: 'quotes', version: '1.0.0', settings: settingsSchema });
const plainPanel = definePanel(quotes, {});

function settingsRoutes(patch: (body: unknown) => unknown) {
  return {
    'GET /api/plugins/quotes/settings': () => ({ values, schema }),
    'PATCH /api/plugins/quotes/settings': ({ body }: { body: unknown }) => patch(body),
    'GET /api/plugins/quotes/secrets': () => ({ secrets: [] }),
  };
}

describe('settings page', () => {
  it('renders the generated form and saves a patch', async () => {
    const harness = await renderApp({
      path: '/settings/quotes',
      plugins: [pluginInfo('quotes')],
      panels: { quotes: plainPanel },
      routes: settingsRoutes((body) => ({ values: { ...values, ...(body as object) } })),
    });
    const volume = await screen.findByLabelText('Volume');
    expect((volume as HTMLInputElement).value).toBe('50');
    expect(screen.getByText('How loud alerts play Between 0 and 100.')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).toHaveProperty('checked', true);
    expect(screen.getByLabelText('Greeting (optional)')).toBeTruthy();
    const limits = screen.getByRole('group', { name: 'Limits' });
    expect(within(limits).getByLabelText('Per minute')).toBeTruthy();
    expect(
      screen.getByText("Either can't be edited here (a value of several types)."),
    ).toBeTruthy();

    await userEvent.clear(volume);
    await userEvent.type(volume, '70');
    await userEvent.selectOptions(screen.getByLabelText('Mode'), 'whisper');
    await userEvent.type(screen.getByLabelText('Banned'), '{enter}scam');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(harness.requests.at(-1)).toMatchObject({
        method: 'PATCH',
        body: {
          volume: 70,
          enabled: true,
          mode: 'whisper',
          banned: ['spam', 'scam'],
          limits: { perMinute: 20 },
        },
      });
    });
    expect(harness.requests.at(-1)?.body).not.toHaveProperty('either');
    expect(await screen.findByText('Settings saved')).toBeTruthy();
  });

  it('maps validation issues onto the fields and keeps the input', async () => {
    await renderApp({
      path: '/settings/quotes',
      plugins: [pluginInfo('quotes')],
      panels: { quotes: plainPanel },
      routes: settingsRoutes(() =>
        apiError(400, 'validation', 'Invalid settings', {
          issues: [
            { path: ['volume'], message: 'Too big: expected number to be <=100' },
            { path: ['limits', 'perMinute'], message: 'Too small' },
          ],
        }),
      ),
    });
    const volume = await screen.findByLabelText('Volume');
    await userEvent.clear(volume);
    await userEvent.type(volume, '500');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Too big: expected number to be <=100')).toBeTruthy();
    expect(volume.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Too small')).toBeTruthy();
    expect(screen.getByText('Some values are not valid.')).toBeTruthy();
    expect((volume as HTMLInputElement).value).toBe('500');
  });

  it('keeps the input when the session ended while editing', async () => {
    const harness = await renderApp({
      path: '/settings/quotes',
      plugins: [pluginInfo('quotes')],
      panels: { quotes: plainPanel },
      routes: settingsRoutes(() => apiError(401, 'unauthorized', 'Login required')),
    });
    const volume = await screen.findByLabelText('Volume');
    await userEvent.clear(volume);
    await userEvent.type(volume, '80');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(harness.session.ended).toBe(true);
    });
    expect(screen.getByLabelText<HTMLInputElement>('Volume').value).toBe('80');
  });

  it("uses the plugin's own form when it ships one", async () => {
    const custom = definePanel(quotes, {
      settings: ({ values: stored, save }) => (
        <div>
          <p>custom form {String(stored.volume)}</p>
          <Button
            onClick={() => {
              void save({ volume: 1 });
            }}
          >
            Quiet
          </Button>
        </div>
      ),
    });
    const harness = await renderApp({
      path: '/settings/quotes',
      plugins: [pluginInfo('quotes')],
      panels: { quotes: custom },
      routes: settingsRoutes((body) => ({ values: { ...values, ...(body as object) } })),
    });
    expect(await screen.findByText('custom form 50')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Quiet' }));
    await waitFor(() => {
      expect(harness.requests.at(-1)).toMatchObject({ method: 'PATCH', body: { volume: 1 } });
    });
  });

  it('is for owners only', async () => {
    await renderApp({ path: '/settings/quotes', user: modUser, plugins: [pluginInfo('quotes')] });
    expect(await screen.findByText('This page is for owners.')).toBeTruthy();
  });

  it('says when a plugin has no settings', async () => {
    await renderApp({
      path: '/settings/quotes',
      plugins: [pluginInfo('quotes', { hasSettings: false })],
      routes: {
        'GET /api/plugins/quotes/settings': () => ({ values: {}, schema: null }),
        'GET /api/plugins/quotes/secrets': () => ({ secrets: [] }),
      },
    });
    expect(await screen.findByText('quotes has no settings.')).toBeTruthy();
  });

  it('renders choice fields as a select filled by the RPC and keeps unknown values visible', async () => {
    const choiceSchema = z.toJSONSchema(
      z.object({ favorite: choice('counter.options').optional() }),
      { io: 'input' },
    );
    const harness = await renderApp({
      path: '/settings/counter',
      plugins: [pluginInfo('counter', { panel: undefined, hasPanel: false })],
      routes: {
        'GET /api/plugins/counter/settings': () => ({
          values: { favorite: 'gone' },
          schema: choiceSchema,
        }),
        'PATCH /api/plugins/counter/settings': ({ body }) => ({ values: body }),
      },
    });
    await waitFor(() => {
      expect(harness.socket.ofType('rpc')).toMatchObject([{ name: 'counter.options' }]);
    });
    act(() => {
      harness.socket.answer('rpc', [
        { value: 'a', label: 'Deaths' },
        { value: 'b', label: 'Wins' },
      ]);
    });
    const select = await screen.findByLabelText<HTMLSelectElement>('Favorite (optional)');
    await waitFor(() => {
      expect([...select.options].map((option) => option.text)).toEqual([
        '-',
        'Unknown: gone',
        'Deaths',
        'Wins',
      ]);
    });
    await userEvent.selectOptions(select, 'b');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(harness.requests.at(-1)).toMatchObject({ method: 'PATCH', body: { favorite: 'b' } });
    });
  });
});
