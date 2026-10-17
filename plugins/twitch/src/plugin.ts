/**
 * The twitch plugin's server side, built around an injected `TwitchClientFactory` so tests run
 * against a fake client (src/server.ts passes the Twurple one).
 *
 * - Settings `clientId` and the secret `clientSecret` are the Twitch application.
 * - The OAuth routes connect the broadcaster and the bot: tokens in the keyed secret `tokens`
 *   (by Twitch user id), the accounts in KV `accounts`.
 * - A runtime (src/runtime.ts) serves the domains for the current credentials and accounts. Any
 *   change to them replaces it. An account whose token Twitch refused to refresh is left out
 *   ("Reconnect required", in memory: a restart tries the stored token again), and so is one
 *   whose authorization was revoked at Twitch.
 * - When Twitch refuses the client ID or secret, the status says so and the runtime keeps going
 *   (the accounts' tokens still work); new credentials clear it.
 *
 * Guide: docs/plugin-guide.md#12-platforms-and-providers; setup: plugins/twitch/README.md.
 */
import { definePlugin, ok } from '@petalbot/sdk';
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
import { errorText } from './redact.ts';
import { startRuntime, type Runtime } from './runtime.ts';
import { REFRESH_RETRY_MS, STATUS_WAIT_MS } from './scopes.ts';
import {
  AppCredentialsError,
  type RefreshFailure,
  type TwitchClient,
  type TwitchClientFactory,
} from './twitch-client.ts';

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

      /** User ids whose token Twitch refused to refresh, or whose authorization it revoked. */
      const reconnectRequired = new Set<string>();
      /** Twitch refused the current client ID or secret; reset when they change. */
      let credentialsRejected = false;

      const appRejected = (): void => {
        if (credentialsRejected) return;
        credentialsRejected = true;
        ctx.log.warn('Twitch rejected the client ID or secret; save the current ones');
        changed();
      };

      /** A client for the current credentials; tokens it refreshes are stored. */
      const newClient = (app: { clientId: string; clientSecret: string }): TwitchClient =>
        createClient({
          ...app,
          log: ctx.log,
          onTokenRefresh: (userId, token) => {
            ctx.secrets.set('tokens', userId, token).catch((error: unknown) => {
              ctx.log.error('Could not store a refreshed Twitch token', {
                error: errorText(error),
              });
            });
          },
          onRefreshFailure: (userId, kind) => {
            refreshFailed(userId, kind).catch(() => undefined);
          },
          onAppRejected: appRejected,
        });

      /** A pending retry after a transient refresh failure (one at a time). */
      let retry: (() => void) | undefined;

      /** Leaves the account out until it is reconnected. */
      const requireReconnect = (kind: AccountKind, userId: string, message: string): void => {
        reconnectRequired.add(userId);
        ctx.log.warn(message, { account: kind });
        startRebuild();
      };

      const refreshFailed = async (userId: string, failure: RefreshFailure): Promise<void> => {
        if (failure === 'app') {
          appRejected();
          return;
        }
        const accounts = (await ctx.kv.get('accounts')) ?? {};
        const kind = AccountKind.options.find((name) => accounts[name]?.id === userId);
        if (kind === undefined || reconnectRequired.has(userId)) return;
        if (failure === 'transient') {
          // Twurple won't refresh this user again on the same client: a fresh one retries.
          if (retry) return;
          ctx.log.warn('Twitch token refresh failed; retrying in a minute', { account: kind });
          retry = ctx.schedule.after(REFRESH_RETRY_MS, () => {
            retry = undefined;
            startRebuild();
          });
          return;
        }
        requireReconnect(kind, userId, 'Twitch token refresh failed; reconnect the account');
      };

      const revoked = (kind: AccountKind, userId: string): void => {
        if (reconnectRequired.has(userId)) return;
        requireReconnect(kind, userId, 'Twitch access was revoked; reconnect the account');
      };

      const changed = (): void => {
        ctx.emit('twitch.connectionChanged', {});
      };

      let runtime: Runtime | undefined;
      /** The latest rebuild; `twitch.status` waits for it briefly. */
      let rebuilding: Promise<void> = Promise.resolve();
      let stopped = false;
      /** Read through a function: `stopped` changes while a rebuild awaits. */
      const isStopped = (): boolean => stopped;

      /** Starts a runtime for the current credentials and accounts, if they allow one. */
      const start = async (): Promise<Runtime | undefined> => {
        const app = await credentials();
        const accounts = (await ctx.kv.get('accounts')) ?? {};
        const { broadcaster } = accounts;
        if (!app || !broadcaster || reconnectRequired.has(broadcaster.id)) return undefined;
        const broadcasterToken = await ctx.secrets.get('tokens', broadcaster.id);
        if (!broadcasterToken) return undefined;
        const bot =
          accounts.bot && !reconnectRequired.has(accounts.bot.id) ? accounts.bot : undefined;
        const botToken = bot ? await ctx.secrets.get('tokens', bot.id) : undefined;
        const client = newClient(app);
        // A refusal is reported through `onAppRejected`; anything else (network) shows up later.
        await client.verifyApp().catch((error: unknown) => {
          if (error instanceof AppCredentialsError) return;
          ctx.log.debug('Could not check the Twitch app credentials', { error: errorText(error) });
        });
        const accountOf = { broadcaster, bot };
        return await startRuntime({
          ctx,
          client,
          broadcaster,
          ...(bot && botToken ? { bot } : {}),
          tokens: { broadcaster: broadcasterToken, ...(botToken ? { bot: botToken } : {}) },
          onChange: changed,
          onRevoked: (kind) => {
            const account = accountOf[kind];
            if (account) revoked(kind, account.id);
          },
        });
      };

      /**
       * Replaces the runtime after the credentials or accounts changed. Serialized, so two quick
       * changes never leave two listeners running.
       */
      const rebuild = (): Promise<void> => {
        const next = ctx.lock('runtime', async () => {
          await runtime?.dispose();
          runtime = undefined;
          if (isStopped()) return;
          try {
            runtime = await start();
          } catch (error) {
            if (!isStopped()) {
              ctx.log.error('Could not start the Twitch connection', { error: errorText(error) });
            }
          }
          // Stopped while starting: the late runtime must not outlive the plugin.
          if (isStopped()) {
            await runtime?.dispose();
            runtime = undefined;
            return;
          }
          changed();
        });
        rebuilding = next.catch(() => undefined);
        return next;
      };

      /** A rebuild nobody waits for: listeners return at once (the core times them out). */
      const startRebuild = (): void => {
        rebuild().catch((error: unknown) => {
          ctx.log.debug('Twitch rebuild skipped', { error: errorText(error) });
        });
      };

      /** Called after an account was connected or removed. */
      const onAccountsChanged = rebuild;

      const credentialsChanged = (): void => {
        credentialsRejected = false;
        startRebuild();
      };
      ctx.settings.onChange((next, previous) => {
        if (next.clientId !== previous.clientId) credentialsChanged();
      });
      ctx.secrets.onChange('clientSecret', credentialsChanged);

      ctx.onDispose(async () => {
        stopped = true;
        await runtime?.dispose();
        runtime = undefined;
      });
      startRebuild();

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
              error: errorText(error),
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
          if (previous && previous.id !== user.id) {
            await ctx.secrets.delete('tokens', previous.id);
            reconnectRequired.delete(previous.id);
          }
          reconnectRequired.delete(user.id);
          ctx.log.info('Twitch account connected', { account: kind, login: user.login });
          await onAccountsChanged();
          return backToPage({ connected: kind });
        },
        { public: true },
      );

      const statusOf = (account: TwitchAccount | undefined): AccountStatus | null =>
        account
          ? {
              ...account,
              state: reconnectRequired.has(account.id) ? 'reconnect-required' : 'connected',
            }
          : null;

      return {
        rpc: {
          async status() {
            // A rebuild in progress usually finishes within moments; a slow Twitch doesn't hold
            // the page up (connectionChanged refreshes it once the rebuild is done).
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              rebuilding,
              new Promise((resolve) => {
                timer = setTimeout(resolve, STATUS_WAIT_MS);
              }),
            ]);
            clearTimeout(timer);
            const live = runtime?.status;
            const accounts = (await ctx.kv.get('accounts')) ?? {};
            return {
              configured: (await credentials()) !== null,
              credentialsRejected,
              redirectUrl: redirectUri,
              broadcaster: statusOf(accounts.broadcaster),
              bot: statusOf(accounts.bot),
              botRole: live?.botRole ?? null,
              eventSub: live ? { ...live.eventSub } : { broadcaster: 'off', bot: 'off' },
            };
          },
          async disconnect({ account: kind }) {
            const account = (await ctx.kv.get('accounts'))?.[kind];
            if (!account) return ok();
            const token = await ctx.secrets.get('tokens', account.id);
            const app = await credentials();
            if (token && app) {
              // Best effort: the account is forgotten here either way.
              await newClient(app)
                .revoke(token)
                .catch((error: unknown) => {
                  ctx.log.debug('Could not revoke the Twitch token', { error: errorText(error) });
                });
            }
            await ctx.secrets.delete('tokens', account.id);
            await ctx.kv.update('accounts', (current) =>
              kind === 'bot'
                ? { ...(current?.broadcaster ? { broadcaster: current.broadcaster } : {}) }
                : { ...(current?.bot ? { bot: current.bot } : {}) },
            );
            reconnectRequired.delete(account.id);
            ctx.log.info('Twitch account disconnected', { account: kind });
            await rebuild();
            return ok();
          },
        },
      };
    },
  });
}
