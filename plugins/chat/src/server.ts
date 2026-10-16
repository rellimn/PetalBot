/**
 * The chat domain's server side: connections, the outbound path and the message buffer.
 *
 * A connection is a live `chat.platform` provider: its key is the connection id, its info the
 * rest. Outbound: resolve the target -> check the capability -> `chat.beforeSend` -> the
 * connection's provider, which applies its own rate limiter. Every outcome is a `Result`; only
 * bugs throw. Inbound: the provider pushes `message`/`messageDeleted`, chat emits the events.
 *
 * Guide: docs/plugin-guide.md#12-platforms-and-providers.
 */
import type { z } from 'zod';
import {
  UnsupportedCapabilityError,
  definePlugin,
  fail,
  sourceOf,
  type Actor,
  type ProviderHandle,
  type Target,
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
} from './contract.ts';
import { RECENT_LIMIT } from './limits.ts';

type Registration = Omit<ConnectionInfo, 'capabilities'>;
type Platform = ProviderHandle<typeof chatContract.providers.platform>;

/** A connection: a live provider and what it registered. */
interface Live {
  readonly info: Registration;
  readonly provider: Platform;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export default definePlugin(chatContract, {
  setup(ctx) {
    const providers = ctx.providers('chat.platform');
    let recent: RecentMessage[] = [];

    // Providers come, change their info and go (also when their plugin stops).
    providers.onChange(() => {
      ctx.emit('chat.connectionsChanged', {});
    });

    const toLive = (provider: Platform): Live => ({
      info: { id: provider.key, platform: sourceOf(provider.key).platform, ...provider.info },
      provider,
    });
    const liveOne = (id: string): Live | undefined => {
      const provider = providers.get(id);
      return provider ? toLive(provider) : undefined;
    };
    const live = (): Live[] => providers.list().map(toLive);

    providers.on('message', (message, provider) => {
      const source = sourceOf(provider.key);
      // Platforms may deliver a message twice (Twitch EventSub is at-least-once).
      const known = recent.some(
        (entry) => entry.id === message.id && entry.source.connection === source.connection,
      );
      if (known) return;
      const full = { ...message, source };
      recent = [...recent, { ...full, deleted: false }].slice(-RECENT_LIMIT);
      ctx.emit('chat.message', full);
    });

    providers.on('messageDeleted', ({ messageId }, provider) => {
      const source = sourceOf(provider.key);
      recent = recent.map((message) =>
        message.id === messageId && message.source.connection === source.connection
          ? { ...message, deleted: true }
          : message,
      );
      ctx.emit('chat.messageDeleted', { source, messageId });
    });

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
      actor: Actor,
      replyTo?: string,
    ): Promise<
      { readonly ok: true; readonly text: string } | z.input<typeof sendVetoed.schema>
    > => {
      const result = await ctx.runHook('chat.beforeSend', {
        connection: connection.info.id,
        text,
        actor,
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

    const send = async (connection: Live, text: string, actor: Actor) => {
      // Before the hook: taps never see a message that can't be sent anyway.
      if (!connection.provider.has('send')) return unsupported(connection, 'send', 'send messages');
      const checked = await beforeSend(connection, text, actor);
      if (!checked.ok) return checked;
      return attempt(connection, 'send', () =>
        connection.provider.call('send', { text: checked.text }),
      );
    };

    return {
      rpc: {
        send: async ({ target, text }, { actor }) => {
          const connection = resolve(target);
          return 'provider' in connection ? send(connection, text, actor) : connection;
        },

        reply: async ({ to, text }, { actor }) => {
          const connection = resolveConnection(to.source.connection);
          if (!('provider' in connection)) return connection;
          if (!connection.provider.has('reply')) return unsupported(connection, 'reply', 'reply');
          const checked = await beforeSend(connection, text, actor, to.id);
          if (!checked.ok) return checked;
          return attempt(connection, 'reply', () =>
            connection.provider.call('reply', {
              to: { id: to.id, user: to.user },
              text: checked.text,
            }),
          );
        },

        broadcast: async ({ text, platforms, connections }, { actor }) => {
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
              await send(connection, text, actor),
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
      },
    };
  },
});
