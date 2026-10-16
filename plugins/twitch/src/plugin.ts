/**
 * The twitch plugin's server side, built around an injected `TwitchClientFactory` so tests run
 * against a fake client (src/server.ts passes the Twurple one).
 *
 * - Settings `clientId` and the secret `clientSecret` are the Twitch application.
 * - The OAuth routes connect the broadcaster and the bot: tokens in the keyed secret `tokens`
 *   (by Twitch user id), the accounts in KV `accounts`.
 *
 * Guide: docs/plugin-guide.md#12-platforms-and-providers; setup: plugins/twitch/README.md.
 */
import { definePlugin } from '@petalbot/sdk';
import { chatContract } from '@petalbot-plugin/chat/contract';
import { streamContract } from '@petalbot-plugin/stream/contract';
import {
  AccountKind,
  Accounts,
  twitchContract,
  type AccountStatus,
  type TwitchAccount,
} from './contract.ts';
import { authorizeUrl, backToPage, createPendingLogins, hasScopes, redirect } from './oauth.ts';
import { startRuntime, type Runtime, type RuntimeStatus } from './runtime.ts';
import type { TwitchClient, TwitchClientFactory } from './twitch-client.ts';

export function createTwitchPlugin(createClient: TwitchClientFactory) {
  return definePlugin(twitchContract, {
    dependencies: [chatContract, streamContract],
    kv: { accounts: Accounts },
    setup(ctx) {
      const pending = createPendingLogins(() => Date.now());
      const redirectUri = ctx.http.url('/auth/callback');

      const credentials = async (): Promise<{ clientId: string; clientSecret: string } | null> => {
        const clientId = ctx.settings.get().clientId;
        const clientSecret = (await ctx.secrets.get('clientSecret')) ?? '';
        return clientId !== '' && clientSecret !== '' ? { clientId, clientSecret } : null;
      };

      /** A client for the current credentials; tokens it refreshes are stored. */
      const newClient = (app: { clientId: string; clientSecret: string }): TwitchClient =>
        createClient({
          ...app,
          log: ctx.log,
          onTokenRefresh: () => undefined,
          onRefreshFailure: () => undefined,
        });

      const changed = (): void => {
        ctx.emit('twitch.connectionChanged', {});
      };

      let runtime: Runtime | undefined;
      let stopped = false;

      /** Starts a runtime for the current credentials and accounts, if they allow one. */
      const start = async (): Promise<Runtime | undefined> => {
        const app = await credentials();
        const accounts = (await ctx.kv.get('accounts')) ?? {};
        const { broadcaster } = accounts;
        if (!app || !broadcaster) return undefined;
        const broadcasterToken = await ctx.secrets.get('tokens', broadcaster.id);
        if (!broadcasterToken) return undefined;
        return await startRuntime({
          ctx,
          client: newClient(app),
          broadcaster,
          tokens: { broadcaster: broadcasterToken },
          onChange: changed,
        });
      };

      /**
       * Replaces the runtime after the credentials or accounts changed. Serialized, so two quick
       * changes never leave two listeners running.
       */
      const rebuild = (): Promise<void> =>
        ctx.lock('runtime', async () => {
          await runtime?.dispose();
          runtime = undefined;
          if (stopped) return;
          try {
            runtime = await start();
          } catch (error) {
            ctx.log.error('Could not start the Twitch connection', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          changed();
        });

      /** Called after an account was connected or removed. */
      const onAccountsChanged = rebuild;

      ctx.onDispose(async () => {
        stopped = true;
        await runtime?.dispose();
        runtime = undefined;
      });
      void rebuild().catch((error: unknown) => {
        ctx.log.debug('Twitch start skipped', { error: String(error) });
      });

      ctx.http.route(
        'GET',
        '/auth/start',
        async (request) => {
          const kind = AccountKind.safeParse(new URL(request.url).searchParams.get('account'));
          if (!kind.success) return new Response('Unknown account', { status: 400 });
          const app = await credentials();
          if (!app) return backToPage({ error: 'not-configured' });
          const state = pending.add(kind.data);
          return redirect(
            authorizeUrl({ clientId: app.clientId, redirectUri, kind: kind.data, state }),
          );
        },
        { role: 'owner' },
      );

      ctx.http.route(
        'GET',
        '/auth/callback',
        async (request) => {
          const params = new URL(request.url).searchParams;
          const kind = pending.take(params.get('state') ?? '');
          if (kind === undefined) return backToPage({ error: 'invalid-state' });
          const code = params.get('code');
          if (params.has('error') || code === null) return backToPage({ error: 'denied' });
          const app = await credentials();
          if (!app) return backToPage({ error: 'not-configured' });

          const client = newClient(app);
          let token;
          let user: TwitchAccount;
          try {
            token = await client.exchangeCode(code, redirectUri);
            user = await client.tokenUser(token);
          } catch (error) {
            ctx.log.warn('Twitch login failed', {
              account: kind,
              error: error instanceof Error ? error.message : String(error),
            });
            return backToPage({ error: 'exchange-failed' });
          }
          if (!hasScopes(kind, token.scope)) return backToPage({ error: 'missing-scopes' });

          const other = kind === 'broadcaster' ? 'bot' : 'broadcaster';
          const accounts = (await ctx.kv.get('accounts')) ?? {};
          if (accounts[other]?.id === user.id) return backToPage({ error: 'same-account' });

          await ctx.secrets.set('tokens', user.id, token);
          const previous = accounts[kind];
          await ctx.kv.update('accounts', (current) => ({ ...current, [kind]: user }));
          if (previous && previous.id !== user.id) await ctx.secrets.delete('tokens', previous.id);
          ctx.log.info('Twitch account connected', { account: kind, login: user.login });
          await onAccountsChanged();
          return backToPage({ connected: kind });
        },
        { public: true },
      );

      const statusOf = (account: TwitchAccount | undefined): AccountStatus | null =>
        account ? { ...account, state: 'connected' } : null;

      return {
        rpc: {
          async status() {
            // Under the lock: a rebuild in progress finishes first.
            const live: RuntimeStatus | undefined = await ctx.lock(
              'runtime',
              () => runtime?.status,
            );
            const accounts = (await ctx.kv.get('accounts')) ?? {};
            return {
              configured: (await credentials()) !== null,
              redirectUrl: redirectUri,
              broadcaster: statusOf(accounts.broadcaster),
              bot: statusOf(accounts.bot),
              botRole: live?.botRole ?? null,
              eventSub: live ? { ...live.eventSub } : { broadcaster: 'off', bot: 'off' },
            };
          },
          disconnect() {
            // Implemented with the runtime's lifecycle (M5c plan, Task 7).
            return Promise.reject(new Error('Not implemented yet'));
          },
        },
      };
    },
  });
}
