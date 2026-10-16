import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  defineContract,
  defineFailure,
  definePlugin,
  fail,
  type Failure,
  type ProviderImpl,
} from '@petalbot/sdk';
import {
  chatContract,
  permissionDenied,
  ReplyResult,
  BroadcastItemResult,
  ProviderSendResult,
} from '../src/contract.ts';

describe('chat failure types', () => {
  it('keeps reply and broadcast narrower than general target lookup', () => {
    expectTypeOf(ReplyResult).not.toBeNever();
    expectTypeOf(BroadcastItemResult).not.toBeNever();
    expectTypeOf(ProviderSendResult).not.toBeNever();
    type Reply = Extract<z.output<typeof ReplyResult>, Failure>;
    type Broadcast = Extract<z.output<typeof BroadcastItemResult>, Failure>;
    expectTypeOf<Reply['error']['code']>().toEqualTypeOf<
      | 'connection-not-found'
      | 'unsupported-capability'
      | 'send-vetoed'
      | 'permission-denied'
      | 'rate-limited'
      | 'message-rejected'
      | 'provider-error'
      | 'message-not-found'
    >();
    expectTypeOf<Broadcast['error']['code']>().toEqualTypeOf<
      Exclude<Reply['error']['code'], 'message-not-found'>
    >();
    expectTypeOf<
      Extract<z.output<typeof ProviderSendResult>, Failure>['error']['code']
    >().toEqualTypeOf<
      'permission-denied' | 'rate-limited' | 'message-rejected' | 'provider-error'
    >();
  });
  it('requires implementers to use domain-provided failures', () => {
    const foreign = defineFailure({
      code: 'twitch-private',
      reason: 'custom',
      details: z.object({}),
    });
    const provider: ProviderImpl<typeof chatContract.providers.platform> = {
      send: () => Promise.resolve(fail(permissionDenied, {})),
    };
    const invalid: ProviderImpl<typeof chatContract.providers.platform> = {
      // @ts-expect-error -- private platform failure is not part of the domain contract
      send: () => Promise.resolve(fail(foreign, {})),
    };
    expectTypeOf(provider).toEqualTypeOf(invalid);
  });
  it('gives dependants the exact payload union', () => {
    definePlugin(defineContract({ id: 'consumer', version: '1.0.0' }), {
      dependencies: [chatContract],
      async setup(ctx) {
        const result = await ctx.call('chat.reply', {
          to: {
            id: 'm',
            source: { platform: 'twitch', connection: 'twitch:a' },
            user: {
              id: 'u',
              login: 'u',
              displayName: 'U',
              badges: { broadcaster: false, moderator: false, vip: false, subscriber: false },
            },
          },
          text: 'hello',
        });
        if (!result.ok) {
          const error = result.error;
          if (error.code === 'message-not-found')
            expectTypeOf(error.messageId).toEqualTypeOf<string>();
          expectTypeOf(result.error).not.toHaveProperty('userId');
        }
      },
    });
  });
});
