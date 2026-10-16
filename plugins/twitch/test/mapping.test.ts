import { describe, expect, it } from 'vitest';
import { InboundMessage } from '@petalbot-plugin/chat/contract';
import { InboundStreamEvent } from '@petalbot-plugin/stream/contract';
import {
  follow,
  gift,
  online,
  raid,
  subscription,
  subscriptionMessage,
  support,
  tierOf,
  toInboundMessage,
} from '../src/mapping.ts';
import type { TwitchChatMessage } from '../src/twitch-client.ts';

const viewer = { id: '7', login: 'viewer', displayName: 'Viewer' };
const message = (overrides: Partial<TwitchChatMessage> = {}): TwitchChatMessage => ({
  messageId: 'm',
  user: viewer,
  text: 'hello',
  badges: [],
  ...overrides,
});

describe('tierOf', () => {
  it('maps Twitch tiers to 1, 2, 3', () => {
    expect(['1000', '2000', '3000', 'prime'].map(tierOf)).toEqual([1, 2, 3, 1]);
  });
});

describe('toInboundMessage', () => {
  it('maps a message with the receipt time', () => {
    const inbound = toInboundMessage(message(), '2', 42);
    expect(inbound).toEqual({
      id: 'm',
      user: {
        ...viewer,
        badges: { broadcaster: false, moderator: false, vip: false, subscriber: false },
      },
      text: 'hello',
      timestamp: 42,
      fromBot: false,
    });
    expect(InboundMessage.safeParse(inbound).success).toBe(true);
  });

  it('marks messages of the bot account', () => {
    expect(toInboundMessage(message({ user: { ...viewer, id: '2' } }), '2', 0).fromBot).toBe(true);
  });

  it('reads the badges, founders count as subscribers', () => {
    const inbound = toInboundMessage(
      message({ badges: ['founder', 'vip', 'broadcaster'] }),
      '2',
      0,
    );
    expect(inbound.user.badges).toEqual({
      broadcaster: true,
      moderator: false,
      vip: true,
      subscriber: true,
    });
  });

  it('keeps the reply and strips the leading mention', () => {
    const reply = { id: 'p', login: 'roman', displayName: 'Roman', text: 'yo' };
    const inbound = toInboundMessage(message({ text: '@Roman hi', reply }), '2', 0);
    expect(inbound.text).toBe('hi');
    expect(inbound.replyTo).toEqual(reply);
    expect(InboundMessage.safeParse(inbound).success).toBe(true);
  });

  it('keeps text that does not start with the mention', () => {
    const reply = { id: 'p', login: 'roman', displayName: 'Roman', text: 'yo' };
    expect(toInboundMessage(message({ text: 'hi @roman', reply }), '2', 0).text).toBe('hi @roman');
  });
});

describe('stream events', () => {
  const valid = (event: unknown): boolean => InboundStreamEvent.safeParse(event).success;

  it('maps online with its start', () => {
    expect(online({ since: 5 })).toEqual({ type: 'online', since: 5 });
  });

  it('maps follows and raids', () => {
    expect(follow({ user: viewer })).toEqual({ type: 'follow', user: viewer });
    const raided = raid({ from: viewer, viewers: 12 });
    expect(raided).toEqual({ type: 'raid', from: viewer, viewers: 12 });
    expect(valid(raided)).toBe(true);
  });

  it('skips gifted subscriptions (the gift event covers them)', () => {
    expect(subscription({ user: viewer, tier: '1000', isGift: true })).toBeNull();
    const own = subscription({ user: viewer, tier: '3000', isGift: false });
    expect(own).toEqual({ type: 'subscription', user: viewer, tier: 3 });
    expect(valid(own)).toBe(true);
  });

  it('maps resubscriptions with months and message', () => {
    const resub = subscriptionMessage({ user: viewer, tier: '1000', months: 7, message: 'gg' });
    expect(resub).toEqual({
      type: 'subscription',
      user: viewer,
      tier: 1,
      months: 7,
      message: 'gg',
    });
    expect(valid(resub)).toBe(true);
  });

  it('maps anonymous gifts without a gifter', () => {
    const gifted = gift({ count: 5, tier: '2000' });
    expect(gifted).toEqual({ type: 'giftSubscription', count: 5, tier: 2 });
    expect('gifter' in gifted).toBe(false);
    expect(valid(gifted)).toBe(true);
    expect(gift({ gifter: viewer, count: 1, tier: '1000' })).toMatchObject({ gifter: viewer });
  });

  it('maps cheers to support in bits', () => {
    const cheered = support({ user: viewer, bits: 100, message: 'Cheer100 gg' });
    expect(cheered).toEqual({
      type: 'support',
      user: viewer,
      amount: 100,
      currency: 'bits',
      message: 'Cheer100 gg',
    });
    expect(valid(cheered)).toBe(true);
    expect('user' in support({ bits: 1, message: '' })).toBe(false);
  });
});
