import { describe, expect, it } from 'vitest';
import { checkContract } from '@petalbot/sdk';
import { SCOPES, chatLimits } from '../src/scopes.ts';
import { twitchContract } from '../src/contract.ts';

describe('twitch contract', () => {
  it('passes the loader checks', () => {
    expect(() => {
      checkContract(twitchContract);
    }).not.toThrow();
  });

  it('asks each account for its scopes', () => {
    expect(SCOPES.broadcaster).toEqual([
      'channel:bot',
      'moderator:read:followers',
      'channel:read:subscriptions',
      'bits:read',
      'moderation:read',
      'channel:read:vips',
    ]);
    expect(SCOPES.bot).toEqual([
      'user:bot',
      'user:read:chat',
      'user:write:chat',
      'moderator:manage:chat_messages',
      'moderator:manage:banned_users',
    ]);
  });

  it('sizes the chat limiter by role', () => {
    expect(chatLimits('none')).toEqual({ limit: 20, minIntervalMs: 1000 });
    expect(chatLimits('vip')).toEqual({ limit: 100, minIntervalMs: 0 });
    expect(chatLimits('moderator')).toEqual({ limit: 100, minIntervalMs: 0 });
  });
});
