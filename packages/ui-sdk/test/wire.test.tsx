import { act, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { codecs, defineContract } from '@petalbot/sdk';
import { ClientError } from '../src/client/errors.ts';
import { createPluginClient } from '../src/client/plugin-client.ts';
import { renderWithPetal } from './render.tsx';

const schedule = defineContract({
  id: 'schedule',
  version: '1.0.0',
  events: {
    moved: { schema: z.object({ at: codecs.isoDate() }), expose: ['panel'] },
  },
  rpc: {
    next: {
      input: z.object({}),
      output: z.object({ at: codecs.isoDate() }),
      expose: { panel: 'mod' },
    },
  },
});
const client = createPluginClient(schedule, { queries: { 'schedule.next': {} } });
const moved = createPluginClient(schedule, {
  queries: {
    'schedule.next': {
      update: { 'schedule.moved': (_data, event) => ({ at: event.payload.at }) },
    },
  },
});

function Next() {
  const next = client.schedule.next.useQuery({});
  const [moved, setMoved] = useState('never');
  client.schedule.moved.useEvent((event) => {
    setMoved(event.payload.at.toISOString());
  });
  return (
    <p>
      next: {next.data?.at.toISOString() ?? (next.error ? next.error.code : '…')} / moved: {moved}
    </p>
  );
}

const envelope = (payload: unknown) => ({
  id: 'e1',
  name: 'schedule.moved',
  payload,
  source: 'schedule',
  timestamp: 1,
  depth: 0,
});

describe('decoding what the server sends', () => {
  it('turns wire values back into the contract types', async () => {
    const { socket } = renderWithPetal(<Next />);
    await waitFor(() => {
      expect(socket.ofType('rpc')).toHaveLength(1);
    });
    act(() => {
      socket.answer('rpc', { at: '2026-10-12T18:30:00.000Z' });
      socket.receive({ type: 'event', envelope: envelope({ at: '2026-10-13T08:00:00.000Z' }) });
    });
    expect(
      await screen.findByText('next: 2026-10-12T18:30:00.000Z / moved: 2026-10-13T08:00:00.000Z'),
    ).toBeTruthy();
  });

  it('drops events and rejects results that do not match the contract', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { socket } = renderWithPetal(<Next />);
    await waitFor(() => {
      expect(socket.ofType('rpc')).toHaveLength(1);
    });
    act(() => {
      socket.answer('rpc', { at: 'not a date' });
      socket.receive({ type: 'event', envelope: envelope({ at: 42 }) });
    });
    expect(await screen.findByText('next: validation / moved: never')).toBeTruthy();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('schedule.moved') as string,
      expect.any(ClientError),
    );
    error.mockRestore();
  });

  it('decodes results of call() outside components too', async () => {
    const { socket } = renderWithPetal(<p>idle</p>);
    const result = client.schedule.next.call({});
    socket.answer('rpc', { at: '2026-10-12T18:30:00.000Z' });
    await expect(result).resolves.toEqual({ at: new Date('2026-10-12T18:30:00.000Z') });
  });

  it('hands decoded payloads to live update functions', async () => {
    function Moved() {
      const next = moved.schedule.next.useQuery({});
      // toISOString() only exists on a Date: an undecoded string would throw here.
      return <p>live: {next.data ? next.data.at.toISOString() : '…'}</p>;
    }
    const { socket } = renderWithPetal(<Moved />);
    await waitFor(() => {
      expect(socket.ofType('rpc')).toHaveLength(1);
    });
    act(() => {
      socket.answer('rpc', { at: '2026-10-12T18:30:00.000Z' });
    });
    expect(await screen.findByText('live: 2026-10-12T18:30:00.000Z')).toBeTruthy();
    act(() => {
      socket.receive({ type: 'event', envelope: envelope({ at: '2026-10-13T08:00:00.000Z' }) });
    });
    expect(await screen.findByText('live: 2026-10-13T08:00:00.000Z')).toBeTruthy();
    expect(socket.ofType('rpc')).toHaveLength(1);
  });
});
