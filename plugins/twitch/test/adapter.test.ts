/**
 * The pure parts of the Twurple adapter: how its errors are read. (The rest is covered by the
 * manual Twitch checklist.)
 */
import { ChatMessageDroppedError } from '@twurple/api';
import { describe, expect, it } from 'vitest';
import { droppedOutcome, refreshFailureKind } from '../src/twitch-client.ts';

/** Twurple's HttpStatusCodeError, as the adapter reads it. */
const httpError = (statusCode: number): Error =>
  Object.assign(new Error(`Encountered HTTP status code ${String(statusCode)}`), {
    statusCode,
    body: '{"status":400,"message":"Invalid refresh token"}',
  });

describe('droppedOutcome', () => {
  it('reads a dropped message', () => {
    const error = new ChatMessageDroppedError(
      '1',
      'You are sending messages too quickly.',
      'msg_ratelimit',
    );
    expect(droppedOutcome(error)).toEqual({
      sent: false,
      code: 'msg_ratelimit',
      message: 'You are sending messages too quickly.',
    });
    expect(droppedOutcome(new ChatMessageDroppedError('1', undefined, undefined))).toEqual({
      sent: false,
      code: 'unknown',
      message: 'unknown reason',
    });
  });

  it('ignores other errors', () => {
    expect(droppedOutcome(new Error('x'))).toBeUndefined();
    expect(droppedOutcome(httpError(500))).toBeUndefined();
  });
});

describe('refreshFailureKind', () => {
  it('only a refused refresh token needs a reconnect', () => {
    expect(refreshFailureKind(httpError(400))).toBe('invalid');
    expect(refreshFailureKind(httpError(401))).toBe('invalid');
    expect(refreshFailureKind(httpError(503))).toBe('transient');
    expect(refreshFailureKind(new TypeError('fetch failed'))).toBe('transient');
  });
});
