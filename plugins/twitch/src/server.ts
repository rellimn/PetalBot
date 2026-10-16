/**
 * The twitch plugin's server entry, built into dist/server/server.js: the plugin with the real
 * Twurple client. Tests use src/plugin.ts with a fake client instead.
 */
import { createTwitchPlugin } from './plugin.ts';
import { createTwurpleClient } from './twitch-client.ts';

export default createTwitchPlugin(createTwurpleClient);
