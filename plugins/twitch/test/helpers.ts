/**
 * Starts the twitch plugin in a harness with a fake Twitch client, and drives its HTTP routes.
 */
import type { PanelUser } from '@petalbot/sdk';
import { createTestHarness } from '@petalbot/testing';
import type { AccountKind, TwitchAccount } from '../src/contract.ts';
import { createTwitchPlugin } from '../src/plugin.ts';
import { bot, broadcaster, createFakeClient, tokenFor, type FakeDefaults } from './fake-client.ts';

export const owner: PanelUser = { id: 'o', name: 'Owner', role: 'owner' };
export const mod: PanelUser = { id: 'm', name: 'Mod', role: 'mod' };

export interface StartOptions {
  /** App credentials; default both set. `false` starts without them. */
  readonly credentials?: false;
  /** Accounts connected through the OAuth flow before the test starts. */
  readonly accounts?: readonly AccountKind[];
  readonly defaults?: FakeDefaults;
}

export async function startTwitch(options: StartOptions = {}) {
  const defaults: FakeDefaults = { ...options.defaults };
  const fake = createFakeClient(defaults);
  const plugin = createTwitchPlugin(fake.factory);
  const harness = await createTestHarness(
    plugin,
    options.credentials === false
      ? {}
      : { settings: { clientId: 'client' }, secrets: { clientSecret: 'secret' } },
  );
  const secrets = harness.kernel.secrets(plugin);

  const get = async (path: string, user: PanelUser | null = owner): Promise<Response> =>
    await harness.kernel.routes.dispatch(
      'twitch',
      new Request(`http://localhost:8080/api/p/twitch${path}`),
      { ...(user ? { user } : {}), sameOrigin: false },
    );

  /** The `state` of a fresh `/auth/start` for `kind`. */
  const startLogin = async (kind: AccountKind): Promise<string> => {
    const response = await get(`/auth/start?account=${kind}`);
    const location = response.headers.get('location') ?? '';
    return new URL(location).searchParams.get('state') ?? '';
  };

  /** Runs the whole OAuth flow for `kind` as `user`; returns the final redirect location. */
  const connect = async (
    kind: AccountKind,
    user: TwitchAccount = kind === 'broadcaster' ? broadcaster : bot,
  ): Promise<string> => {
    defaults.user = () => Promise.resolve(user);
    defaults.exchange = () => Promise.resolve(tokenFor(kind, `${user.id}-token`));
    const state = await startLogin(kind);
    const response = await get(`/auth/callback?code=c&state=${state}`, null);
    await harness.idle();
    return response.headers.get('location') ?? '';
  };

  for (const kind of options.accounts ?? []) await connect(kind);

  return { harness, fake, defaults, secrets, get, startLogin, connect };
}
