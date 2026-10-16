import { describe, expect, it } from 'vitest';
import { fail, rateLimitedFailure } from '@petalbot/sdk';
import {
  ProviderSendResult,
  ProviderReplyResult,
  ProviderDeleteResult,
  ProviderTimeoutResult,
  SendResult,
  ReplyResult,
  BroadcastItemResult,
  DeleteResult,
  TimeoutResult,
  connectionNotFound,
  platformNotConnected,
  ambiguousTarget,
  unsupportedCapability,
  sendVetoed,
  providerError,
  permissionDenied,
  messageRejected,
  messageNotFound,
  userNotFound,
} from '../src/contract.ts';

const failures = {
  connection: fail(connectionNotFound, { connection: 'twitch:a' }),
  platform: fail(platformNotConnected, { platform: 'twitch' }),
  ambiguous: fail(ambiguousTarget, { platform: 'twitch', connections: ['twitch:a', 'twitch:b'] }),
  unsupported: fail(unsupportedCapability, { connection: 'twitch:a', capability: 'send' }),
  veto: fail(sendVetoed, { connection: 'twitch:a', vetoedBy: 'filter' }),
  provider: fail(providerError, { connection: 'twitch:a', capability: 'send' }),
  permission: fail(permissionDenied, {}),
  rejected: fail(messageRejected, {}),
  message: fail(messageNotFound, { messageId: 'm1' }),
  user: fail(userNotFound, { userId: 'u1' }),
  limited: fail(rateLimitedFailure, {}),
};

describe('operation-specific chat failures', () => {
  it.each([
    [ProviderSendResult, ['permission', 'limited', 'rejected', 'provider']],
    [ProviderReplyResult, ['permission', 'limited', 'rejected', 'provider', 'message']],
    [ProviderDeleteResult, ['permission', 'message', 'provider']],
    [ProviderTimeoutResult, ['permission', 'user', 'provider']],
    [
      SendResult,
      [
        'connection',
        'platform',
        'ambiguous',
        'unsupported',
        'veto',
        'permission',
        'limited',
        'rejected',
        'provider',
      ],
    ],
    [
      ReplyResult,
      [
        'connection',
        'unsupported',
        'veto',
        'permission',
        'limited',
        'rejected',
        'provider',
        'message',
      ],
    ],
    [
      BroadcastItemResult,
      ['connection', 'unsupported', 'veto', 'permission', 'limited', 'rejected', 'provider'],
    ],
    [
      DeleteResult,
      ['connection', 'platform', 'ambiguous', 'unsupported', 'permission', 'message', 'provider'],
    ],
    [
      TimeoutResult,
      ['connection', 'platform', 'ambiguous', 'unsupported', 'permission', 'user', 'provider'],
    ],
  ])('accepts only the declared failures for row %#', (schema, allowed) => {
    for (const [name, failure] of Object.entries(failures)) {
      expect(schema.safeParse(failure).success, name).toBe(allowed.includes(name));
    }
  });
});
