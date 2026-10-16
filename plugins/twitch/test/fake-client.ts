/**
 * A fake `TwitchClient`: records every call, answers with overridable defaults, and lets a test
 * play EventSub through the handlers of the last `listen`.
 */
import type { BotRole, TwitchAccount, TwitchToken } from '../src/contract.ts';
import { SCOPES } from '../src/scopes.ts';
import type {
  SendOutcome,
  TwitchClient,
  TwitchClientFactory,
  TwitchClientOptions,
  TwitchEventHandlers,
} from '../src/twitch-client.ts';

export const broadcaster: TwitchAccount = { id: '1', login: 'roman', displayName: 'Roman' };
export const bot: TwitchAccount = { id: '2', login: 'petalbot', displayName: 'PetalBot' };

export const tokenFor = (
  kind: 'broadcaster' | 'bot',
  accessToken = `${kind}-token`,
): TwitchToken => ({
  accessToken,
  refreshToken: `${accessToken}-refresh`,
  scope: [...SCOPES[kind]],
  expiresIn: 3600,
  obtainmentTimestamp: 0,
});

export interface FakeClient extends TwitchClient {
  readonly options: TwitchClientOptions;
  readonly calls: { readonly method: string; readonly input: unknown }[];
  /** True between `listen` and `stop`. */
  listening: boolean;
  listenUsers: { broadcasterId: string; botId?: string | undefined } | undefined;
  handlers(): TwitchEventHandlers;
  exchange: (code: string) => Promise<TwitchToken>;
  user: (token: TwitchToken) => Promise<TwitchAccount>;
  stream: () => Promise<{ readonly since: number } | null>;
  role: () => Promise<BotRole>;
  send: (text: string) => Promise<SendOutcome>;
  delete: () => Promise<void>;
  timeout: () => Promise<void>;
  revokeImpl: () => Promise<void>;
}

/** Defaults every new client starts with; tests change them before the client is created. */
export interface FakeDefaults {
  exchange?: FakeClient['exchange'];
  user?: FakeClient['user'];
  stream?: FakeClient['stream'];
  role?: FakeClient['role'];
  send?: FakeClient['send'];
  revoke?: FakeClient['revokeImpl'];
}

export function createFakeClient(defaults: FakeDefaults = {}) {
  const created: FakeClient[] = [];
  const factory: TwitchClientFactory = (options) => {
    let handlers: TwitchEventHandlers | undefined;
    const calls: FakeClient['calls'] = [];
    const record = (method: string, input: unknown): void => {
      calls.push({ method, input });
    };
    const client: FakeClient = {
      options,
      calls,
      listening: false,
      listenUsers: undefined,
      handlers() {
        if (!handlers) throw new Error('listen was not called');
        return handlers;
      },
      exchange: defaults.exchange ?? (() => Promise.resolve(tokenFor('broadcaster'))),
      user: defaults.user ?? (() => Promise.resolve(broadcaster)),
      stream: defaults.stream ?? (() => Promise.resolve(null)),
      role: defaults.role ?? (() => Promise.resolve('none')),
      send: defaults.send ?? (() => Promise.resolve({ sent: true, messageId: 'm1' })),
      delete: () => Promise.resolve(),
      timeout: () => Promise.resolve(),
      revokeImpl: defaults.revoke ?? (() => Promise.resolve()),
      exchangeCode(code, redirectUri) {
        record('exchangeCode', { code, redirectUri });
        return client.exchange(code);
      },
      tokenUser(token) {
        record('tokenUser', token);
        return client.user(token);
      },
      revoke(token) {
        record('revoke', token);
        return client.revokeImpl();
      },
      addUser(userId, token) {
        record('addUser', { userId, token });
      },
      getStream(broadcasterId) {
        record('getStream', broadcasterId);
        return client.stream();
      },
      botRole(broadcasterId, botId) {
        record('botRole', { broadcasterId, botId });
        return client.role();
      },
      sendMessage(input) {
        record('sendMessage', input);
        return client.send(input.text);
      },
      deleteMessage(input) {
        record('deleteMessage', input);
        return client.delete();
      },
      timeoutUser(input) {
        record('timeoutUser', input);
        return client.timeout();
      },
      listen(users, next) {
        record('listen', users);
        handlers = next;
        client.listenUsers = users;
        client.listening = true;
        return {
          stop() {
            client.listening = false;
          },
        };
      },
    };
    created.push(client);
    return client;
  };
  return {
    factory,
    created,
    last(): FakeClient {
      const client = created.at(-1);
      if (!client) throw new Error('No client was created');
      return client;
    },
  };
}
