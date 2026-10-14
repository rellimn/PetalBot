import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { defineContract } from '@petalbot/sdk';
import { definePanel } from '@petalbot/ui-sdk';
import { apiError, modUser, pluginInfo, renderApp } from './harness.tsx';

const quotes = defineContract({ id: 'quotes', version: '1.0.0' });

let shouldCrash = true;
function Crashy() {
  if (shouldCrash) throw new Error('quote parser exploded');
  return <p>recovered</p>;
}

const panel = definePanel(quotes, {
  pages: [
    { path: 'list', title: 'Quotes', minRole: 'mod', component: () => <p>quote list</p> },
    { path: 'admin', title: 'Quote admin', component: () => <p>owner things</p> },
    { path: 'crash', title: 'Crash', component: Crashy },
  ],
});

describe('plugin pages', () => {
  it('renders a running plugin page from its bundle', async () => {
    await renderApp({
      path: '/p/quotes/list',
      plugins: [pluginInfo('quotes')],
      panels: { quotes: panel },
    });
    expect(await screen.findByText('quote list')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Quotes' })).toBeTruthy();
  });

  it('shows "not running" with Enable for owners and returns automatically', async () => {
    const harness = await renderApp({
      path: '/p/quotes/list',
      plugins: [pluginInfo('quotes')],
      panels: { quotes: panel },
      routes: { 'POST /api/plugins/quotes/enable': () => pluginInfo('quotes') },
    });
    await screen.findByText('quote list');
    harness.setPlugin(
      pluginInfo('quotes', { state: 'disabled', enabled: false, panel: undefined }),
    );
    expect(await screen.findByText('quotes is not running')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Enable' }));
    expect(harness.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/plugins/quotes/enable',
    });
    harness.setPlugin(pluginInfo('quotes'));
    expect(await screen.findByText('quote list')).toBeTruthy();
  });

  it('asks before enabling the plugins it needs', async () => {
    const harness = await renderApp({
      path: '/p/quotes/list',
      plugins: [pluginInfo('quotes', { state: 'disabled', enabled: false, panel: undefined })],
      routes: {
        'POST /api/plugins/quotes/enable': ({ body }) =>
          (body as { withDependencies?: boolean }).withDependencies === true
            ? pluginInfo('quotes')
            : apiError(409, 'confirmation_required', 'Enabling "quotes" also enables: chat', {
                plugins: ['chat'],
              }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enable quotes?' });
    expect(dialog.textContent).toContain('chat');
    await userEvent.click(screen.getByRole('button', { name: 'Enable all 2' }));
    await waitFor(() => {
      expect(harness.requests.at(-1)).toMatchObject({ body: { withDependencies: true } });
    });
  });

  it('keeps owner-only pages and the Enable button from mods', async () => {
    const harness = await renderApp({
      path: '/p/quotes/admin',
      user: modUser,
      plugins: [pluginInfo('quotes')],
      panels: { quotes: panel },
    });
    expect(await screen.findByText('This page is for owners.')).toBeTruthy();
    harness.setPlugin(
      pluginInfo('quotes', { state: 'disabled', enabled: false, panel: undefined }),
    );
    expect(await screen.findByText('quotes is not running')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
  });

  it('contains a crashing page in an error card with Reload', async () => {
    shouldCrash = true;
    await renderApp({
      path: '/p/quotes/crash',
      plugins: [pluginInfo('quotes')],
      panels: { quotes: panel },
    });
    expect(await screen.findByText(/quote parser exploded/)).toBeTruthy();
    shouldCrash = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('recovered')).toBeTruthy();
  });

  it('reports bundles that cannot be loaded', async () => {
    await renderApp({
      path: '/p/quotes/list',
      plugins: [pluginInfo('quotes')],
      panels: { quotes: () => Promise.reject(new Error('bundle 404')) },
    });
    expect(await screen.findByText(/bundle 404/)).toBeTruthy();
  });

  it('answers unknown plugins and pages', async () => {
    await renderApp({
      path: '/p/nope/x',
      plugins: [pluginInfo('quotes')],
      panels: { quotes: panel },
    });
    expect(await screen.findByText('Unknown plugin')).toBeTruthy();
  });
});
