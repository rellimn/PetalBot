/**
 * The Twitch page's client. `twitch.status` stays live: every account, role or EventSub change
 * emits `twitch.connectionChanged`, which refetches it.
 */
import { createPluginClient } from '@petalbot/ui-sdk';
import { twitchContract } from './contract.ts';

export const api = createPluginClient(twitchContract, {
  queries: {
    'twitch.status': { refreshOn: ['twitch.connectionChanged'] },
  },
});
