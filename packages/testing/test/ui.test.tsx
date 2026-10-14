// @vitest-environment happy-dom
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';
import { createPluginClient } from '@petalbot/ui-sdk';
import { renderPluginUi } from '../src/ui.ts';

const notes = defineContract({
  id: 'notes',
  version: '1.0.0',
  events: { added: { schema: z.object({ text: z.string() }), expose: ['panel'] } },
  rpc: { list: { output: z.array(z.string()), expose: { panel: 'mod' } } },
});
const api = createPluginClient(notes, {
  queries: {
    'notes.list': { update: { 'notes.added': (list, event) => [...list, event.payload.text] } },
  },
});

function Notes() {
  const list = api.notes.list.useQuery();
  return <p>{list.data?.join(', ') ?? 'loading'}</p>;
}

describe('renderPluginUi', () => {
  it('answers calls and delivers events', async () => {
    const { server } = renderPluginUi(<Notes />);
    expect(await screen.findByText('loading')).toBeTruthy();
    await waitFor(() => {
      expect(server.calls('notes.list')).toHaveLength(1);
    });
    act(() => {
      server.answer('notes.list', ['a']);
    });
    expect(await screen.findByText('a')).toBeTruthy();
    act(() => {
      server.emit('notes.added', { text: 'b' });
    });
    expect(await screen.findByText('a, b')).toBeTruthy();
  });
});
