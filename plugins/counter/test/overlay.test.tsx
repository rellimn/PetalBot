// @vitest-environment happy-dom
/** Overlay test: the OBS display follows its counter live and hides it once it's deleted. */
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderPluginUi } from '@petalbot/testing/ui';
import overlay from '../src/overlays/display.tsx';

const Display = overlay.component;

describe('display overlay', () => {
  it('follows its counter live', async () => {
    const { server } = renderPluginUi(<Display config={{ counter: 'a', size: 'large' }} />);
    await waitFor(() => {
      expect(server.calls('counter.get')).toHaveLength(1);
    });
    act(() => {
      server.answer('counter.get', { id: 'a', name: 'Deaths', value: 3 });
    });
    expect(await screen.findByText('Deaths')).toBeTruthy();
    act(() => {
      server.emit('counter.changed', { counter: 'a', value: 4, by: 'x' });
    });
    expect(await screen.findByText('4')).toBeTruthy();
  });

  it('hides a deleted counter', async () => {
    const { server } = renderPluginUi(<Display config={{ counter: 'a', size: 'medium' }} />);
    await waitFor(() => {
      expect(server.calls('counter.get')).toHaveLength(1);
    });
    act(() => {
      server.answer('counter.get', { id: 'a', name: 'Deaths', value: 3 });
    });
    await screen.findByText('Deaths');
    act(() => {
      server.emit('counter.listChanged', {});
    });
    await waitFor(() => {
      expect(server.calls('counter.get')).toHaveLength(2);
    });
    act(() => {
      server.answer('counter.get', null);
    });
    await waitFor(() => {
      expect(screen.queryByText('Deaths')).toBeNull();
    });
  });
});
