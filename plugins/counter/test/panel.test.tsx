// @vitest-environment happy-dom
/**
 * Panel tests for the counter: the page and the widget, rendered with @petalbot/testing/ui
 * against a fake server. `server.answer` plays the server's side of an RPC, `server.emit` sends
 * an event, so these tests show how live queries react.
 *
 * Guide: docs/plugin-guide.md#8-testing.
 */
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPluginUi } from '@petalbot/testing/ui';
import panel from '../src/panel.tsx';

const CountersPage = panel.pages[0]?.component ?? (() => null);
const CounterWidget =
  panel.widgets.find((widget) => widget.id === 'value')?.component ?? (() => null);

const deaths = { id: 'a', name: 'Deaths', value: 3 };

describe('Counters page', () => {
  it('lists counters, counts and follows changes from elsewhere', async () => {
    const { server } = renderPluginUi(<CountersPage />);
    await waitFor(() => {
      expect(server.calls('counter.list')).toHaveLength(1);
    });
    act(() => {
      server.answer('counter.list', [deaths]);
    });
    expect(await screen.findByText('Deaths')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '+1 Deaths' }));
    expect(server.calls('counter.increment').at(-1)).toMatchObject({ input: { counter: 'a' } });
    act(() => {
      server.answer('counter.increment', { ok: true, counter: { ...deaths, value: 4 } });
      server.emit('counter.changed', { counter: 'a', value: 4, by: 'Tester' });
    });
    expect(await screen.findByText('4')).toBeTruthy();
    // increment doesn't invalidate: the event already updated the list (see client.ts).
    expect(server.calls('counter.list')).toHaveLength(1);
  });

  it('presents a disappeared counter without diagnostic text', async () => {
    const { server } = renderPluginUi(<CountersPage />);
    await waitFor(() => {
      expect(server.calls('counter.list')).toHaveLength(1);
    });
    act(() => {
      server.answer('counter.list', [deaths]);
    });
    await userEvent.click(await screen.findByRole('button', { name: '+1 Deaths' }));
    act(() => {
      server.answer('counter.increment', {
        ok: false,
        reason: 'not-found',
        error: { code: 'counter-not-found', counterId: 'a' },
        message: 'DIAGNOSTIC_ONLY',
      });
    });
    expect(await screen.findByText('Deaths no longer exists.')).toBeTruthy();
    expect(screen.queryByText('DIAGNOSTIC_ONLY')).toBeNull();
  });

  it('creates counters and shows why a name is refused', async () => {
    const { server } = renderPluginUi(<CountersPage />);
    await waitFor(() => {
      expect(server.calls('counter.list')).toHaveLength(1);
    });
    act(() => {
      server.answer('counter.list', []);
    });
    await userEvent.type(await screen.findByLabelText('New counter'), 'Deaths');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    act(() => {
      server.fail('counter.create', 'validation', 'A counter with this name already exists');
    });
    expect(await screen.findByText('Could not create the counter')).toBeTruthy();
    expect(screen.getByText('A counter with this name already exists')).toBeTruthy();
  });
});

describe('Counter widget', () => {
  it('shows its counter and a +1 button', async () => {
    const { server } = renderPluginUi(<CounterWidget config={{ counter: 'a' }} instanceId="w1" />);
    await waitFor(() => {
      expect(server.calls('counter.get')).toMatchObject([{ input: { counter: 'a' } }]);
    });
    act(() => {
      server.answer('counter.get', deaths);
    });
    expect(await screen.findByText('3')).toBeTruthy();
    act(() => {
      server.emit('counter.changed', { counter: 'b', value: 9, by: 'x' });
    });
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('shows a deleted counter as deleted', async () => {
    const { server } = renderPluginUi(
      <CounterWidget config={{ counter: 'gone' }} instanceId="w1" />,
    );
    await waitFor(() => {
      expect(server.calls('counter.get')).toHaveLength(1);
    });
    act(() => {
      server.answer('counter.get', null);
    });
    expect(await screen.findByText('This counter was deleted')).toBeTruthy();
  });
});
