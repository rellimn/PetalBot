import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';
import { definePanel } from '@petalbot/ui-sdk';
import { apiError, pluginInfo, renderApp, type HarnessOptions } from './harness.tsx';

const apiKey = { name: 'apiKey', label: 'API key', description: 'From the vendor', set: false };
const webhook = { name: 'webhook', label: 'Webhook secret', set: true };
const settingsSchema = z.object({ volume: z.number().default(50) });
const quotes = defineContract({ id: 'quotes', version: '1.0.0', settings: settingsSchema });
const settings = {
  values: { volume: 50 },
  schema: z.toJSONSchema(settingsSchema, { io: 'input' }),
};

async function renderSecrets(routes: HarnessOptions['routes'], panel = definePanel(quotes, {})) {
  return renderApp({
    path: '/settings/quotes',
    plugins: [pluginInfo('quotes')],
    panels: { quotes: panel },
    routes: {
      'GET /api/plugins/quotes/settings': () => settings,
      'GET /api/plugins/quotes/secrets': () => ({ secrets: [apiKey, webhook] }),
      ...routes,
    },
  });
}

const rowOf = async (label: string) =>
  within(await screen.findByRole('region', { name: 'Secrets' })).getByRole('listitem', {
    name: label,
  });

describe('secrets card', () => {
  it('shows whether each secret is set, never a value', async () => {
    await renderSecrets({});
    const key = await rowOf('API key');
    expect(within(key).getByText('Not set')).toBeTruthy();
    expect(within(key).getByText('From the vendor')).toBeTruthy();
    expect(within(key).queryByRole('button', { name: 'Clear' })).toBeNull();
    const hook = await rowOf('Webhook secret');
    expect(within(hook).getByText('Set')).toBeTruthy();
    expect(within(hook).getByRole('button', { name: 'Replace' })).toBeTruthy();
  });

  it('sets a value from a password field', async () => {
    const harness = await renderSecrets({
      'PUT /api/plugins/quotes/secrets/apiKey': () => ({ ...apiKey, set: true }),
    });
    const row = await rowOf('API key');
    await userEvent.click(within(row).getByRole('button', { name: 'Set value' }));
    const input = within(row).getByLabelText<HTMLInputElement>('New value for API key');
    expect(input.type).toBe('password');
    expect(within(row).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    await userEvent.type(input, 'sk-123');
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(harness.requests.at(-1)).toMatchObject({
        method: 'PUT',
        path: '/api/plugins/quotes/secrets/apiKey',
        body: { value: 'sk-123' },
      });
    });
    expect(await screen.findByText('API key saved')).toBeTruthy();
    expect(within(row).getByText('Set')).toBeTruthy();
    expect(within(row).queryByLabelText('New value for API key')).toBeNull();
  });

  it('keeps the typed value when saving fails', async () => {
    await renderSecrets({
      'PUT /api/plugins/quotes/secrets/apiKey': () =>
        apiError(409, 'conflict', 'Plugin "quotes" cannot be loaded'),
    });
    const row = await rowOf('API key');
    await userEvent.click(within(row).getByRole('button', { name: 'Set value' }));
    await userEvent.type(within(row).getByLabelText('New value for API key'), 'sk-9');
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saving failed')).toBeTruthy();
    expect(within(row).getByLabelText<HTMLInputElement>('New value for API key').value).toBe(
      'sk-9',
    );
  });

  it('clears a secret after confirmation', async () => {
    const harness = await renderSecrets({
      'DELETE /api/plugins/quotes/secrets/webhook': () => undefined,
    });
    const row = await rowOf('Webhook secret');
    await userEvent.click(within(row).getByRole('button', { name: 'Clear' }));
    const dialog = await screen.findByRole('dialog', { name: 'Clear Webhook secret?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));
    await waitFor(() => {
      expect(harness.requests.at(-1)).toMatchObject({
        method: 'DELETE',
        path: '/api/plugins/quotes/secrets/webhook',
      });
    });
    expect(await within(row).findByText('Not set')).toBeTruthy();
  });

  it('shows only the card for a plugin with secrets but no settings schema', async () => {
    await renderApp({
      path: '/settings/quotes',
      plugins: [pluginInfo('quotes')],
      routes: {
        'GET /api/plugins/quotes/settings': () => ({ values: {}, schema: null }),
        'GET /api/plugins/quotes/secrets': () => ({ secrets: [apiKey] }),
      },
    });
    expect(await rowOf('API key')).toBeTruthy();
    expect(screen.queryByText('quotes has no settings.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('shows the card below a custom settings form', async () => {
    const custom = definePanel(quotes, { settings: () => <p>custom form</p> });
    await renderSecrets({}, custom);
    expect(await screen.findByText('custom form')).toBeTruthy();
    expect(await rowOf('API key')).toBeTruthy();
  });

  it('says when the secrets could not be loaded', async () => {
    await renderSecrets({
      'GET /api/plugins/quotes/secrets': () => apiError(409, 'conflict', 'Broken plugin'),
    });
    expect(await screen.findByText(/Secrets could not be loaded/)).toBeTruthy();
  });
});
