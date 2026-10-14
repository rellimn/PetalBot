import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from './harness.tsx';

describe('appearance and routing basics', () => {
  it('applies the saved scheme and density to the document', async () => {
    await renderApp({
      path: '/no/such/page',
      routes: {
        'GET /api/me/preferences': () => ({
          darkScheme: 'lavender',
          lightScheme: 'cream',
          mode: 'dark',
          density: 'compact',
          activePreset: null,
        }),
      },
    });
    expect(await screen.findByText('Page not found')).toBeTruthy();
    await waitFor(() => {
      expect(document.documentElement.dataset.scheme).toBe('lavender');
    });
    expect(document.documentElement.dataset.density).toBe('compact');
  });
});
