/**
 * The Chat widget: the recent messages of every connection, live, and a send box.
 *
 * Messages from the bot's account are set apart; deleted ones stay, struck through. With more
 * than one connection each message names its connection, and a picker chooses where to send.
 */
import { useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  Spinner,
  createStore,
  definePanel,
  useStore,
} from '@petalbot/ui-sdk';
import { presentSendFailure } from './failure.ts';
import { api } from './client.ts';
import { chatContract, type ConnectionInfo, type RecentMessage } from './contract.ts';
import styles from './panel.module.css';

/** Where the send box sends; kept across navigation, reset by a reload. */
const target = createStore({ connection: '' }, { name: 'chat.target' });

function Message({
  message,
  showSource,
}: {
  readonly message: RecentMessage;
  readonly showSource: boolean;
}) {
  return (
    <li
      className={styles.message}
      data-from-bot={message.fromBot || undefined}
      data-deleted={message.deleted || undefined}
    >
      {/* Real spaces between the parts, so screen readers and copies keep the words apart. */}
      {showSource ? (
        <>
          <Badge>{message.source.connection}</Badge>{' '}
        </>
      ) : null}
      {message.fromBot ? (
        <>
          <Badge tone="accent">bot</Badge>{' '}
        </>
      ) : null}
      <span className={styles.author}>{message.user.displayName}:</span>{' '}
      <span className={styles.text}>{message.text}</span>
      {message.deleted ? <span className={styles.note}> (deleted)</span> : null}
    </li>
  );
}

/** The connection to send to: the picked one while it exists, else the default, else the first. */
function chosen(
  connections: readonly ConnectionInfo[],
  picked: string,
): ConnectionInfo | undefined {
  return (
    connections.find((connection) => connection.id === picked) ??
    connections.find((connection) => connection.isDefault) ??
    connections[0]
  );
}

function SendBox({ connections }: { readonly connections: readonly ConnectionInfo[] }) {
  const picked = useStore(target, (state) => state.connection);
  const [text, setText] = useState('');
  const send = api.chat.send.useMutation({
    error: 'Could not send the message',
    presentFailure: presentSendFailure,
  });
  const sendable = connections.filter((connection) => connection.capabilities.includes('send'));
  const connection = chosen(sendable, picked);
  if (!connection) {
    return <p className={styles.note}>No chat connection can send messages</p>;
  }
  return (
    <form
      className={styles.send}
      onSubmit={(event) => {
        event.preventDefault();
        send.mutate(
          { target: { connection: connection.id }, text },
          {
            onSuccess: (result) => {
              if (result.ok) setText('');
            },
          },
        );
      }}
    >
      {sendable.length > 1 ? (
        <Select
          aria-label="Send to"
          value={connection.id}
          options={sendable.map((option) => ({ value: option.id, label: option.id }))}
          onChange={(event) => {
            target.set({ connection: event.target.value });
          }}
        />
      ) : null}
      <Input
        aria-label="Message"
        placeholder={`Send to ${connection.id}`}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <Button
        type="submit"
        variant="primary"
        loading={send.isPending}
        disabled={text.trim() === ''}
      >
        Send
      </Button>
    </form>
  );
}

function ChatWidget() {
  const recent = api.chat.recent.useQuery();
  const connections = api.chat.connections.useQuery();
  if (recent.isPending || connections.isPending) return <Spinner label="Loading the chat" />;
  const list = connections.data ?? [];
  const messages = recent.data ?? [];
  return (
    <div className={styles.widget}>
      {messages.length === 0 ? (
        <EmptyState title={list.length === 0 ? 'No chat connected' : 'No messages yet'} />
      ) : (
        // Newest first in a column-reverse list: the view stays at the newest message.
        <ol className={styles.messages} aria-label="Chat messages">
          {messages.toReversed().map((message) => (
            <Message
              key={JSON.stringify([message.source.connection, message.id])}
              message={message}
              showSource={list.length > 1}
            />
          ))}
        </ol>
      )}
      <SendBox connections={list} />
    </div>
  );
}

export default definePanel(chatContract, {
  widgets: {
    chat: {
      title: 'Chat',
      description: 'Recent chat messages and a send box',
      minRole: 'mod',
      component: ChatWidget,
    },
  },
});
