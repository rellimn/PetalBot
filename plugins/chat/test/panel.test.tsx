// @vitest-environment happy-dom
/**
 * The Chat widget against a fake server: live messages, deletions, the bot's messages and the
 * send box with its connection picker.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPluginUi, type FakeServer } from '@petalbot/testing/ui';
import panel from '../src/panel.tsx';
import type { ConnectionInfo } from '../src/contract.ts';
import { RECENT_LIMIT } from '../src/limits.ts';
import { message, twitch } from './fixtures.ts';

const ChatWidget = panel.widgets.find((widget) => widget.id === 'chat')?.component ?? (() => null);

const connection = (overrides: Partial<ConnectionInfo> = {}): ConnectionInfo => ({
  ...twitch,
  capabilities: ['send', 'reply'],
  ...overrides,
});

/** Renders the widget and answers its two queries. */
async function show(recent: unknown[], connections: ConnectionInfo[]): Promise<FakeServer> {
  const { server } = renderPluginUi(<ChatWidget config={{}} instanceId="w1" />);
  await waitFor(() => {
    expect(server.calls('chat.recent')).toHaveLength(1);
    expect(server.calls('chat.connections')).toHaveLength(1);
  });
  act(() => {
    server.answer('chat.recent', recent);
    server.answer('chat.connections', connections);
  });
  return server;
}

const texts = () =>
  within(screen.getByRole('list', { name: 'Chat messages' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent);

describe('Chat widget', () => {
  it('shows recent messages newest first and follows the chat live', async () => {
    const server = await show([{ ...message('m1'), deleted: false }], [connection()]);
    expect(await screen.findByText('message m1')).toBeTruthy();
    act(() => {
      server.emit('chat.message', message('m2', { text: 'second' }));
    });
    expect(await screen.findByText('second')).toBeTruthy();
    expect(texts()).toEqual(['Viewer: second', 'Viewer: message m1']);
    act(() => {
      server.emit('chat.messageDeleted', {
        source: { platform: 'twitch', connection: 'twitch:roman' },
        messageId: 'm1',
      });
    });
    expect(await screen.findByText('(deleted)')).toBeTruthy();
    // Live through `update`: no refetch per message.
    expect(server.calls('chat.recent')).toHaveLength(1);
  });

  it('keeps a live copy without duplicates and at the server limit', async () => {
    const server = await show(
      Array.from({ length: RECENT_LIMIT }, (_, n) => ({
        ...message(`m${String(n)}`),
        deleted: false,
      })),
      [connection()],
    );
    expect(await screen.findByText('message m0')).toBeTruthy();
    act(() => {
      server.emit('chat.message', message('new'));
      server.emit('chat.message', message('new'));
    });
    expect(await screen.findByText('message new')).toBeTruthy();
    expect(texts()).toHaveLength(RECENT_LIMIT);
    expect(screen.queryByText('message m0')).toBeNull();
  });

  it("sets the bot's messages apart", async () => {
    await show([{ ...message('m1', { fromBot: true }), deleted: false }], [connection()]);
    const item = (await screen.findByText('message m1')).closest('li');
    expect(item?.dataset.fromBot).toBe('true');
    expect(within(item as HTMLElement).getByText('bot')).toBeTruthy();
  });

  it('sends to the only connection and clears the box', async () => {
    const server = await show([], [connection()]);
    expect(await screen.findByText('No messages yet')).toBeTruthy();
    const box = screen.getByLabelText<HTMLInputElement>('Message');
    expect(box.placeholder).toBe('Send to twitch:roman');
    expect(screen.queryByLabelText('Send to')).toBeNull();
    await userEvent.type(box, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(server.calls('chat.send').at(-1)).toMatchObject({
      input: { target: { connection: 'twitch:roman' }, text: 'hello' },
    });
    act(() => {
      server.answer('chat.send', { ok: true, messageId: 'x' });
    });
    await waitFor(() => {
      expect(box.value).toBe('');
    });
  });

  it('keeps the text and tells why when sending failed', async () => {
    const server = await show([], [connection()]);
    const box = await screen.findByLabelText<HTMLInputElement>('Message');
    await userEvent.type(box, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    act(() => {
      server.answer('chat.send', {
        ok: false,
        reason: 'forbidden',
        error: { code: 'send-vetoed', connection: 'twitch:roman', vetoedBy: 'filter' },
        message: 'Vetoed by filter: no links',
      });
    });
    expect(await screen.findByText('Message blocked by a chat rule.')).toBeTruthy();
    expect(screen.queryByText('Vetoed by filter: no links')).toBeNull();
    expect(box.value).toBe('hello');
  });

  it('explains a connection disappearing while retaining the draft', async () => {
    const server = await show([], [connection()]);
    const box = await screen.findByLabelText<HTMLInputElement>('Message');
    await userEvent.type(box, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    act(() => {
      server.answer('chat.send', {
        ok: false,
        reason: 'not-found',
        error: { code: 'connection-not-found', connection: 'twitch:roman' },
        message: 'DIAGNOSTIC_ONLY',
      });
    });
    expect(
      await screen.findByText(
        'This chat connection is no longer available. Choose another connection.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('DIAGNOSTIC_ONLY')).toBeNull();
    expect(box.value).toBe('hello');
  });

  it('offers a picker with several connections, starting at the default', async () => {
    const server = await show(
      [],
      [
        connection({ id: 'kick:roman', platform: 'kick', isDefault: false }),
        connection(),
        connection({ id: 'youtube:roman', platform: 'youtube', capabilities: [] }),
      ],
    );
    const picker = await screen.findByLabelText<HTMLSelectElement>('Send to');
    expect(picker.value).toBe('twitch:roman');
    // youtube:roman can't send, so it isn't offered.
    expect([...picker.options].map((option) => option.value)).toEqual([
      'kick:roman',
      'twitch:roman',
    ]);
    await userEvent.selectOptions(picker, 'kick:roman');
    await userEvent.type(screen.getByLabelText('Message'), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(server.calls('chat.send').at(-1)).toMatchObject({
      input: { target: { connection: 'kick:roman' } },
    });
  });

  it('falls back to the default connection when the picked one goes away', async () => {
    const kick = connection({ id: 'kick:roman', platform: 'kick', isDefault: false });
    const server = await show([], [kick, connection()]);
    await userEvent.selectOptions(await screen.findByLabelText('Send to'), 'kick:roman');
    act(() => {
      server.emit('chat.connectionsChanged', {});
    });
    await waitFor(() => {
      expect(server.calls('chat.connections')).toHaveLength(2);
    });
    act(() => {
      server.answer('chat.connections', [connection()]);
    });
    await waitFor(() => {
      expect(screen.queryByLabelText('Send to')).toBeNull();
    });
    expect(screen.getByLabelText<HTMLInputElement>('Message').placeholder).toBe(
      'Send to twitch:roman',
    );
  });

  it('keeps Send disabled for blank text', async () => {
    await show([], [connection()]);
    await userEvent.type(await screen.findByLabelText('Message'), '   ');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true);
  });

  it('says so when no connection can send', async () => {
    await show([], [connection({ capabilities: ['delete'] })]);
    expect(await screen.findByText('No chat connection can send messages')).toBeTruthy();
    expect(screen.queryByLabelText('Message')).toBeNull();
  });

  it('refetches the connections when they change', async () => {
    const server = await show([], []);
    expect(await screen.findByText('No chat connected')).toBeTruthy();
    expect(screen.getByText('No chat connection can send messages')).toBeTruthy();
    act(() => {
      server.emit('chat.connectionsChanged', {});
    });
    await waitFor(() => {
      expect(server.calls('chat.connections')).toHaveLength(2);
    });
    act(() => {
      server.answer('chat.connections', [connection()]);
    });
    expect(await screen.findByLabelText('Message')).toBeTruthy();
  });
});
