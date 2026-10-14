import type { SocketLike } from '@petalbot/ui-sdk';

export type Sent = Record<string, unknown> & { type: string; id?: string };

/** A WebSocket stand-in the test drives from the server side. */
export class FakeSocket implements SocketLike {
  static readonly all: FakeSocket[] = [];
  readonly url: string;
  readonly sent: Sent[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }

  static latest(): FakeSocket {
    const socket = FakeSocket.all.at(-1);
    if (!socket) throw new Error('no socket was created');
    return socket;
  }

  static reset(): void {
    FakeSocket.all.length = 0;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Sent);
  }

  close(): void {
    // the test decides when the "server" closes
  }

  receive(message: object): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  ofType(type: string): Sent[] {
    return this.sent.filter((message) => message.type === type);
  }

  answer(type: string, result: unknown = null, match?: (message: Sent) => boolean): void {
    const message = this.ofType(type)
      .filter((sent) => match?.(sent) ?? true)
      .at(-1);
    if (message?.id === undefined) throw new Error(`no ${type} message to answer`);
    this.receive({ type: 'reply', id: message.id, result });
  }
}
