import type { PanelUser } from '@petalbot/sdk';
import type { SocketLike } from '../src/client/connection.ts';

export type Sent = Record<string, unknown> & { type: string; id?: string };

export const ownerUser: PanelUser = { id: 'u-owner', name: 'roman', role: 'owner' };

/** A WebSocket stand-in the test drives from the server side. */
export class FakeSocket implements SocketLike {
  static readonly all: FakeSocket[] = [];
  readonly url: string;
  readyState = 0;
  readonly sent: Sent[] = [];
  closedByClient = false;
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
    this.closedByClient = true;
  }

  /** Server greets: the connection is open. */
  hello(user: PanelUser = ownerUser): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
    this.receive({ type: 'hello', identity: { kind: 'panel', user } });
  }

  receive(message: object): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code }));
  }

  ofType(type: string): Sent[] {
    return this.sent.filter((message) => message.type === type);
  }

  /** Answers the last client message of `type` (optionally matching `field`). */
  answer(type: string, result: unknown = null, match?: (message: Sent) => boolean): void {
    const message = this.ofType(type)
      .filter((sent) => match?.(sent) ?? true)
      .at(-1);
    if (message?.id === undefined) throw new Error(`no ${type} message to answer`);
    this.receive({ type: 'reply', id: message.id, result });
  }

  fail(type: string, code: string, message = code, match?: (message: Sent) => boolean): void {
    const sent = this.ofType(type)
      .filter((candidate) => match?.(candidate) ?? true)
      .at(-1);
    if (sent?.id === undefined) throw new Error(`no ${type} message to answer`);
    this.receive({ type: 'reply', id: sent.id, error: { code, message } });
  }
}
