import { describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel.ts';
import { LogRing } from '../../src/log-ring.ts';
import { createLogger } from '../../src/logger.ts';
import { ClientGateway, type ClientTransport } from '../../src/server/gateway/gateway.ts';
import type { ClientIdentity } from '../../src/server/identity.ts';
import { modUser, ownerUser } from './fixtures.ts';

type Message = Record<string, unknown>;

class Transport implements ClientTransport {
  readonly messages: Message[] = [];
  bufferedAmount = 0;
  closed: number | undefined;
  failOn: string | undefined;

  send(data: string): void {
    const message = JSON.parse(data) as Message;
    if (message.type === this.failOn) throw new Error('socket broke');
    this.messages.push(message);
  }

  close(code: number): void {
    this.closed = code;
  }

  ofType(type: string): Message[] {
    return this.messages.filter((message) => message.type === type);
  }
}

const owner: ClientIdentity = { kind: 'panel', sessionId: 's1', user: ownerUser };
const mod: ClientIdentity = { kind: 'panel', sessionId: 's2', user: modUser };

function setup() {
  const ring = new LogRing();
  const logger = createLogger({ destination: { write: () => undefined }, sink: ring.push });
  const gateway = new ClientGateway({
    kernel: new Kernel({ logger }),
    plugins: {
      onChange: () => () => undefined,
      onRemoved: () => () => undefined,
      overlayBundle: () => undefined,
    },
    logger,
    logs: ring,
  });
  const connect = (identity: ClientIdentity) => {
    const transport = new Transport();
    const connection = gateway.connect(identity, transport);
    return {
      transport,
      send: (message: object) => {
        connection.receive(JSON.stringify(message));
      },
    };
  };
  return { ring, logger, connect };
}

describe('ClientGateway log stream', () => {
  it('streams log entries to owners who asked for them, until they stop', () => {
    const { logger, connect } = setup();
    const ownerSocket = connect(owner);
    const modSocket = connect(mod);
    ownerSocket.send({ type: 'logs', id: '1' });
    modSocket.send({ type: 'logs', id: '1' });
    expect(modSocket.transport.ofType('reply')).toEqual([
      { type: 'reply', id: '1', error: { code: 'forbidden', message: 'Logs are for owners only' } },
    ]);
    logger.child({ plugin: 'quotes' }).info('hello', { n: 1 });
    expect(ownerSocket.transport.ofType('log.entry')).toEqual([
      {
        type: 'log.entry',
        entry: {
          id: 1,
          time: expect.any(Number) as number,
          level: 'info',
          plugin: 'quotes',
          message: 'hello',
          data: { n: 1 },
        },
      },
    ]);
    ownerSocket.send({ type: 'logs', id: '2', enabled: false });
    logger.info('after stop');
    expect(ownerSocket.transport.ofType('log.entry')).toHaveLength(1);
  });

  it('stops the inspector stream with enabled: false', () => {
    const { connect } = setup();
    const socket = connect(owner);
    socket.send({ type: 'inspect', id: '1' });
    socket.send({ type: 'inspect', id: '2', enabled: false });
    expect(socket.transport.ofType('reply')).toEqual([
      { type: 'reply', id: '1', result: null },
      { type: 'reply', id: '2', result: null },
    ]);
  });

  it('does not deliver entries logged while delivering log entries', () => {
    const { ring, logger, connect } = setup();
    const socket = connect(owner);
    socket.send({ type: 'logs', id: '1' });
    socket.transport.failOn = 'log.entry';
    expect(() => {
      logger.info('trigger');
    }).not.toThrow();
    // The send failure was logged (kept in the ring) and closed the socket, without a loop.
    expect(ring.list({ limit: 10 }).map((entry) => entry.message)).toEqual([
      'Sending to a client failed',
      'trigger',
    ]);
    expect(socket.transport.closed).toBe(1011);
  });
});
