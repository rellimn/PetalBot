import { describe, expect, it } from 'vitest';
import { isOverlayPage, overlaySocketUrl, parseOverlayAddress } from '../src/location.ts';

const at = (pathname: string, search = '') => ({ pathname, search });

describe('overlay URLs', () => {
  it('reads plugin, overlay, instance and the token', () => {
    expect(parseOverlayAddress(at('/overlay/alerts/quote-box/01J0ABC', '?t=s3cr%2Bt'))).toEqual({
      pluginId: 'alerts',
      overlay: 'quote-box',
      instanceId: '01J0ABC',
      credential: { kind: 'token', token: 's3cr+t' },
    });
  });

  it('reads the preview flag', () => {
    expect(parseOverlayAddress(at('/overlay/alerts/box/i1', '?preview'))).toMatchObject({
      credential: { kind: 'preview' },
    });
  });

  it('refuses incomplete or foreign URLs', () => {
    expect(parseOverlayAddress(at('/overlay/alerts/box/i1'))).toBeUndefined();
    expect(parseOverlayAddress(at('/overlay/alerts/box/i1', '?t='))).toBeUndefined();
    expect(parseOverlayAddress(at('/overlay/Alerts/box/i1', '?t=x'))).toBeUndefined();
    expect(parseOverlayAddress(at('/overlay/_/assets/x.js', '?t=x'))).toBeUndefined();
    expect(parseOverlayAddress(at('/admin/overlays', '?t=x'))).toBeUndefined();
  });

  it('knows which paths are overlay pages', () => {
    expect(isOverlayPage('/overlay/alerts/box/i1')).toBe(true);
    expect(isOverlayPage('/overlay/_/index.html')).toBe(false);
    expect(isOverlayPage('/overlay/_/src/main.tsx')).toBe(false);
    expect(isOverlayPage('/overlay/alerts/box/i1/x')).toBe(false);
  });

  it('builds the socket URL with the credential', () => {
    const token = parseOverlayAddress(at('/overlay/alerts/box/i1', '?t=a b'));
    const preview = parseOverlayAddress(at('/overlay/alerts/box/i1', '?preview'));
    if (!token || !preview) throw new Error('unparsed');
    expect(overlaySocketUrl({ protocol: 'https:', host: 'bot.example' }, token)).toBe(
      'wss://bot.example/ws?t=a%20b',
    );
    expect(overlaySocketUrl({ protocol: 'http:', host: '127.0.0.1:5173' }, preview)).toBe(
      'ws://127.0.0.1:5173/ws?preview=i1',
    );
  });
});
