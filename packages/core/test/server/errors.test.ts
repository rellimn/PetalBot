import { describe, expect, it } from 'vitest';
import { AccessError, PluginUnavailableError, RpcTimeoutError } from '@petalbot/sdk';
import { ApiError, statusOf, toWireError } from '../../src/server/errors.ts';
import { hashToken, randomToken } from '../../src/server/tokens.ts';

describe('toWireError', () => {
  it('keeps the message of intended errors and hides everything else', () => {
    expect(toWireError(new PluginUnavailableError('chat'))).toEqual({
      code: 'unavailable',
      message: 'Plugin "chat" is not running',
    });
    expect(toWireError(new RpcTimeoutError('chat.send', 5000)).code).toBe('timeout');
    expect(toWireError(new AccessError('nope'))).toEqual({ code: 'forbidden', message: 'nope' });
    expect(toWireError(new ApiError(409, 'confirmation_required', 'confirm')).code).toBe(
      'confirmation_required',
    );
    expect(toWireError(new Error('secret detail'))).toEqual({
      code: 'internal',
      message: 'Internal error',
    });
    expect(toWireError('thrown string')).toEqual({ code: 'internal', message: 'Internal error' });
  });

  it('maps codes to HTTP statuses', () => {
    expect(statusOf('validation')).toBe(400);
    expect(statusOf('unauthorized')).toBe(401);
    expect(statusOf('forbidden')).toBe(403);
    expect(statusOf('not_found')).toBe(404);
    expect(statusOf('confirmation_required')).toBe(409);
    expect(statusOf('internal')).toBe(500);
  });
});

describe('tokens', () => {
  it('are 256-bit, URL-safe and stored as SHA-256 hex', () => {
    const token = randomToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(randomToken()).not.toBe(token);
  });
});
