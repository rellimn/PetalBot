import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineContract, definePlugin, type ProviderHandle, type Provided } from '@petalbot/sdk';
import { createTestHarness } from '../src/harness.ts';

const chatContract = defineContract({
  id: 'chat',
  version: '1.0.0',
  providers: {
    platform: {
      info: z.object({ channel: z.string() }),
      methods: {
        send: {
          input: z.object({ text: z.string() }),
          output: z.object({ messageId: z.string() }),
        },
      },
      inbound: { message: z.object({ text: z.string() }) },
    },
  },
});
const chat = definePlugin(chatContract, { setup: () => undefined });

const twitchContract = defineContract({
  id: 'twitch',
  version: '1.0.0',
  secrets: {
    clientSecret: { userSettable: true, label: 'Client secret' },
    tokens: { schema: z.object({ accessToken: z.string() }), keyed: true },
  },
});
const twitch = definePlugin(twitchContract, {
  dependencies: [chatContract],
  setup: () => undefined,
});

describe('harness types', () => {
  it('types fake providers from the own slots', async () => {
    const harness = await createTestHarness(chat, {
      providers: {
        'chat.platform': {
          'twitch:test': {
            info: { channel: 'test' },
            methods: { send: () => Promise.resolve({ messageId: '1' }) },
          },
        },
      },
    });
    // @ts-expect-error -- not a slot of the plugin under test
    await createTestHarness(chat, { providers: { 'chat.nope': {} } });
    expectTypeOf(
      harness.addProvider('chat.platform', 'k', {
        info: { channel: 'k' },
        methods: { send: () => Promise.resolve({ messageId: '2' }) },
      }),
    ).toEqualTypeOf<Provided<(typeof chatContract)['providers']['platform']>>();
    harness.addProvider('chat.platform', 'k', {
      info: { channel: 'k' },
      // @ts-expect-error -- wrong output shape
      methods: { send: () => Promise.resolve({ id: 2 }) },
    });
    // @ts-expect-error -- the slot declares info
    harness.addProvider('chat.platform', 'k', {});
    // @ts-expect-error -- chat implements no dependency slot
    harness.provider('chat.platform', 'k');
  });

  it("types the implementer's handle and secrets", async () => {
    const harness = await createTestHarness(twitch, {
      secrets: { clientSecret: 's', tokens: { u1: { accessToken: 'a' } } },
    });
    const handle = harness.provider('chat.platform', 'twitch:x');
    expectTypeOf(handle).toEqualTypeOf<
      ProviderHandle<(typeof chatContract)['providers']['platform']> | undefined
    >();
    expectTypeOf(harness.pushed('chat.platform', 'twitch:x')).toEqualTypeOf<
      readonly { readonly name: 'message'; readonly payload: { text: string } }[]
    >();
    if (handle) {
      expectTypeOf(await handle.call('send', { text: 'hi' })).toEqualTypeOf<{
        messageId: string;
      }>();
    }
    await harness.setSecret('clientSecret', 'x');
    await harness.setSecret('tokens', 'u2', { accessToken: 'b' });
    // @ts-expect-error -- keyed secrets need a key
    await harness.setSecret('tokens', { accessToken: 'b' });
    // @ts-expect-error -- keyed seeds are records
    await createTestHarness(twitch, { secrets: { tokens: 'x' } });
  });
});
