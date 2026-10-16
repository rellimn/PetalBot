import { describe, expect, it } from 'vitest';
import { errorText, redact } from '../src/redact.ts';
import { startTwitch, recordingLogger } from './helpers.ts';

const LEAKY =
  'Encountered HTTP status code 400: Bad Request\n\nURL: https://id.twitch.tv/oauth2/token?' +
  'grant_type=refresh_token&client_id=client&client_secret=secret&refresh_token=rt-123&code=c-9';

describe('redact', () => {
  it('removes secrets from query strings', () => {
    const text = redact(LEAKY);
    for (const value of ['secret', 'rt-123', 'c-9']) expect(text).not.toContain(`=${value}`);
    expect(text).toContain('client_secret=[redacted]');
    expect(text).toContain('refresh_token=[redacted]');
    expect(text).toContain('client_id=client');
    expect(errorText(new Error('access_token=abc&x=1'))).toBe('access_token=[redacted]&x=1');
  });

  it('a failed login logs no secrets', async () => {
    const logger = recordingLogger();
    const { defaults, get, harness, startLogin } = await startTwitch({ logger });
    defaults.exchange = () => Promise.reject(new Error(LEAKY));
    const state = await startLogin('bot');
    await get(`/auth/callback?code=c-9&state=${state}`, null);
    const logged = logger.lines.join('\n');
    expect(logged).toContain('Twitch login failed');
    expect(logged).not.toContain('client_secret=secret');
    expect(logged).not.toContain('rt-123');
    await harness.stop();
  });
});
