/**
 * The chat domain's server side: connections, the outbound path and the message buffer.
 *
 * Outbound: resolve the target -> check the capability -> `chat.beforeSend` -> the connection's
 * provider, which applies its own rate limiter. Every outcome is a `Result`; only bugs throw.
 * Inbound: the providing platform plugin calls `chat.ingest`, chat emits `chat.message`.
 *
 * Guide: docs/plugin-guide.md#12-platforms-and-providers.
 */
import type { z } from 'zod';
import {
  AccessError,
  UnsupportedCapabilityError,
  ValidationError,
  definePlugin,
  fail,
  type ProviderHandle,
} from '@petalbot/sdk';
import {
  Capability,
  chatContract,
  connectionNotFound,
  platformNotConnected,
  ambiguousTarget,
  unsupportedCapability,
  sendVetoed,
  providerError,
  type BroadcastItemResult,
  type ConnectionInfo,
  type RecentMessage,
  type Source,
  type Target,
} from './contract.ts';
import { RECENT_LIMIT } from './limits.ts';

type Registration = Omit<ConnectionInfo, 'capabilities'>;
type Platform = ProviderHandle<typeof chatContract.providers.platform>;

/** A registered connection whose provider is still there. */
interface Live {
  readonly info: Registration;
  readonly provider: Platform;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export default definePlugin(chatContract, {
  setup(ctx) {
    const providers = ctx.providers('chat.platform');
    /** Registered connections by id, with the plugin that provides each. */
    const registered = new Map<string, { readonly info: Registration; readonly by: string }>();
    let recent: RecentMessage[] = [];

    // A provider that goes away (disposed, or its plugin stopped) takes its connection along.
    providers.onChange(({ key, pluginId, change }) => {
      if (change === 'removed' && registered.get(key)?.by === pluginId) {
        registered.delete(key);
        ctx.emit('chat.connectionsChanged', {});
      }
    });

    const liveOne = (id: string): Live | undefined => {
      const entry = registered.get(id);
      const provider = providers.get(id);
      return entry && provider?.pluginId === entry.by ? { info: entry.info, provider } : undefined;
    };
    const live = (): Live[] => [...registered.keys()].flatMap((id) => liveOne(id) ?? []);

    const resolveConnection = (id: string): Live | z.input<typeof connectionNotFound.schema> =>
      liveOne(id) ??
      fail(connectionNotFound, { connection: id }, `There is no chat connection "${id}"`);

    const resolve = (target: Target) => {
      if ('connection' in target) return resolveConnection(target.connection);
      const candidates = live().filter(({ info }) => info.platform === target.platform);
      const chosen =
        candidates.find(({ info }) => info.isDefault) ??
        (candidates.length === 1 ? candidates[0] : undefined);
      if (chosen) return chosen;
      if (candidates.length === 0)
        return fail(
          platformNotConnected,
          { platform: target.platform },
          `No ${target.platform} chat is connected`,
        );
      return fail(
        ambiguousTarget,
        { platform: target.platform, connections: candidates.map(({ info }) => info.id) },
        `Several ${target.platform} chats are connected and none is the default`,
      );
    };

    /** Only the plugin that provides a connection may speak for it. */
    const assertOwner = (source: Source, caller: string): void => {
      const entry = registered.get(source.connection);
      if (entry?.by !== caller || entry.info.platform !== source.platform) {
        throw new AccessError(
          `Plugin "${caller}" has not registered the chat connection "${source.connection}"`,
        );
      }
    };

    const unsupported = (connection: Live, capability: Capability, what: string) =>
      fail(
        unsupportedCapability,
        { connection: connection.info.id, capability },
        `${connection.info.displayName} (${connection.info.id}) cannot ${what}`,
      );

    /** Calls the provider; a throwing provider is a `platform-error`, logged. */
    const attempt = async <T>(
      connection: Live,
      method: Capability,
      run: () => Promise<T>,
    ): Promise<
      T | z.input<typeof unsupportedCapability.schema> | z.input<typeof providerError.schema>
    > => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof UnsupportedCapabilityError) {
          return unsupported(connection, method, method);
        }
        ctx.log.error('Chat provider failed', {
          connection: connection.info.id,
          method,
          error: errorText(error),
        });
        return fail(
          providerError,
          { connection: connection.info.id, capability: method },
          `${connection.info.id}: ${errorText(error)}`,
        );
      }
    };

    /** Runs `chat.beforeSend`: the final text, or `forbidden` when a tap vetoed. */
    const beforeSend = async (
      connection: Live,
      text: string,
      caller: string,
      replyTo?: string,
    ): Promise<
      { readonly ok: true; readonly text: string } | z.input<typeof sendVetoed.schema>
    > => {
      const result = await ctx.runHook('chat.beforeSend', {
        connection: connection.info.id,
        text,
        caller,
        ...(replyTo === undefined ? {} : { replyTo }),
      });
      return result.vetoed
        ? fail(
            sendVetoed,
            { connection: connection.info.id, vetoedBy: result.vetoedBy },
            `Vetoed by ${result.vetoedBy}: ${result.reason}`,
          )
        : { ok: true, text: result.value.text };
    };

    const send = async (connection: Live, text: string, caller: string) => {
      // Before the hook: taps never see a message that can't be sent anyway.
      if (!connection.provider.has('send')) return unsupported(connection, 'send', 'send messages');
      const checked = await beforeSend(connection, text, caller);
      if (!checked.ok) return checked;
      return attempt(connection, 'send', () =>
        connection.provider.call('send', { text: checked.text }),
      );
    };

    return {
      rpc: {
        send: async ({ target, text }, { caller }) => {
          const connection = resolve(target);
          return 'provider' in connection ? send(connection, text, caller) : connection;
        },

        reply: async ({ to, text }, { caller }) => {
          const connection = resolveConnection(to.source.connection);
          if (!('provider' in connection)) return connection;
          if (!connection.provider.has('reply')) return unsupported(connection, 'reply', 'reply');
          const checked = await beforeSend(connection, text, caller, to.id);
          if (!checked.ok) return checked;
          return attempt(connection, 'reply', () =>
            connection.provider.call('reply', {
              to: { id: to.id, user: to.user },
              text: checked.text,
            }),
          );
        },

        broadcast: async ({ text, platforms, connections }, { caller }) => {
          const chosen = live().filter(
            ({ info }) =>
              (platforms === undefined || platforms.includes(info.platform)) &&
              (connections === undefined || connections.includes(info.id)),
          );
          // Every requested connection gets an answer, also one that is not there.
          const missing = (connections ?? [])
            .filter((id) => liveOne(id) === undefined)
            .map((id): [string, BroadcastItemResult] => [
              id,
              fail(connectionNotFound, { connection: id }, `There is no chat connection "${id}"`),
            ]);
          // In parallel: a slow or failing platform delays or blocks no other.
          const results = await Promise.all(
            chosen.map(async (connection): Promise<[string, BroadcastItemResult]> => [
              connection.info.id,
              await send(connection, text, caller),
            ]),
          );
          return Object.fromEntries([...results, ...missing]);
        },

        delete: async ({ target, messageId }) => {
          const connection = resolve(target);
          if (!('provider' in connection)) return connection;
          if (!connection.provider.has('delete'))
            return unsupported(connection, 'delete', 'delete messages');
          return attempt(connection, 'delete', () =>
            connection.provider.call('delete', { messageId }),
          );
        },

        timeout: async ({ target, userId, seconds, reason }) => {
          const connection = resolve(target);
          if (!('provider' in connection)) return connection;
          if (!connection.provider.has('timeout'))
            return unsupported(connection, 'timeout', 'time out users');
          return attempt(connection, 'timeout', () =>
            connection.provider.call('timeout', {
              userId,
              seconds,
              ...(reason === undefined ? {} : { reason }),
            }),
          );
        },

        connections: () =>
          live().map(({ info, provider }) => ({
            ...info,
            capabilities: Capability.options.filter((method) => provider.has(method)),
          })),

        recent: () => recent,

        registerConnection: (info, { caller }) => {
          if (!info.id.startsWith(`${info.platform}:`)) {
            throw new ValidationError('chat connection', [
              {
                code: 'custom',
                path: ['id'],
                message: `A ${info.platform} connection id starts with "${info.platform}:"`,
                input: info.id,
              },
            ]);
          }
          if (providers.get(info.id)?.pluginId !== caller) {
            throw new AccessError(
              `Plugin "${caller}" does not provide "chat.platform" for "${info.id}" (call ctx.provide first)`,
            );
          }
          registered.set(info.id, { info, by: caller });
          ctx.emit('chat.connectionsChanged', {});
          return {};
        },

        ingest: (message, { caller }) => {
          assertOwner(message.source, caller);
          // Platforms may deliver a message twice (Twitch EventSub is at-least-once).
          const known = recent.some(
            (entry) =>
              entry.id === message.id && entry.source.connection === message.source.connection,
          );
          if (known) return {};
          recent = [...recent, { ...message, deleted: false }].slice(-RECENT_LIMIT);
          ctx.emit('chat.message', message);
          return {};
        },

        ingestDeleted: ({ source, messageId }, { caller }) => {
          assertOwner(source, caller);
          recent = recent.map((message) =>
            message.id === messageId && message.source.connection === source.connection
              ? { ...message, deleted: true }
              : message,
          );
          ctx.emit('chat.messageDeleted', { source, messageId });
          return {};
        },
      },
    };
  },
});
