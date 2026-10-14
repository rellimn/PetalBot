import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOGIN_COOKIE, SESSION_COOKIE } from '../../src/server/http/cookies.ts';
import { CLIENT_ID, CLIENT_SECRET, startFakeIssuer, type FakeIssuer } from './fake-issuer.ts';
import { ORIGIN, cookiesOf, createTestServer, type TestServer } from './helpers.ts';

let issuer: FakeIssuer;
beforeAll(async () => {
  issuer = await startFakeIssuer();
});
afterAll(async () => {
  await issuer.close();
});

function oidcServer(): Promise<TestServer> {
  return createTestServer({
    allowInsecureOidc: true,
    env: { PETALBOT_DEV_AUTH: '', PETALBOT_OIDC_CLIENT_SECRET: CLIENT_SECRET },
    config: {
      oidc: {
        issuer: issuer.url,
        clientId: CLIENT_ID,
        groups: { 'petalbot-owners': 'owner', 'petalbot-mods': 'mod' },
      },
    },
  });
}

/** Runs /auth/login -> provider -> /auth/callback and returns the callback response. */
async function logIn(
  server: TestServer,
  user: { sub: string; groups: string[]; name?: string },
  returnTo = '/plugins',
): Promise<Response> {
  const login = await server.request(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`, {
    as: 'anonymous',
  });
  expect(login.status).toBe(302);
  const location = login.headers.get('location') ?? '';
  const query = issuer.approve(location, user);
  const loginCookie = cookiesOf(login)[LOGIN_COOKIE] ?? '';
  return server.request(`/auth/callback?${query}`, {
    as: 'anonymous',
    headers: { cookie: `${LOGIN_COOKIE}=${loginCookie}` },
  });
}

describe('OIDC login', () => {
  it('logs in through the provider, sending the public redirect_uri', async () => {
    const server = await oidcServer();
    const login = await server.request('/auth/login', { as: 'anonymous' });
    const location = new URL(login.headers.get('location') ?? '');
    expect(location.origin).toBe(issuer.url);
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');

    // app.request() uses http://localhost/..., like a proxy forwarding to an internal address.
    const callback = await logIn(server, { sub: 'u1', groups: ['petalbot-owners'], name: 'roman' });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/plugins');
    const session = cookiesOf(callback)[SESSION_COOKIE] ?? '';
    const me = await server.request('/api/me', {
      as: 'anonymous',
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    await expect(me.json()).resolves.toEqual({
      user: { id: 'u1', name: 'roman', role: 'owner' },
      devAuth: false,
    });
    await server.close();
  });

  it('maps the highest group and rejects users without a mapped group', async () => {
    const server = await oidcServer();
    const mod = await logIn(server, { sub: 'u2', groups: ['users', 'petalbot-mods'] });
    expect(mod.status).toBe(302);
    const stranger = await logIn(server, { sub: 'u3', groups: ['users'] });
    expect(stranger.status).toBe(403);
    await expect(stranger.json()).resolves.toMatchObject({ error: { code: 'forbidden' } });
    expect(cookiesOf(stranger)[SESSION_COOKIE]).toBeUndefined();
    await server.close();
  });

  it('rejects a callback with a wrong state or without the login cookie', async () => {
    const server = await oidcServer();
    const login = await server.request('/auth/login', { as: 'anonymous' });
    const query = new URLSearchParams(
      issuer.approve(login.headers.get('location') ?? '', {
        sub: 'u1',
        groups: ['petalbot-owners'],
      }),
    );
    query.set('state', 'forged');
    const forged = await server.request(`/auth/callback?${query.toString()}`, {
      as: 'anonymous',
      headers: { cookie: `${LOGIN_COOKIE}=${cookiesOf(login)[LOGIN_COOKIE] ?? ''}` },
    });
    expect(forged.status).toBe(400);
    await expect(forged.json()).resolves.toMatchObject({ error: { code: 'auth_failed' } });
    const noCookie = await server.request(`/auth/callback?${query.toString()}`, {
      as: 'anonymous',
    });
    expect(noCookie.status).toBe(400);
    await server.close();
  });

  it('keeps running while the provider is down and logs in once it is back', async () => {
    const server = await oidcServer();
    issuer.failDiscovery = true;
    const down = await server.request('/auth/login', { as: 'anonymous' });
    expect(down.status).toBe(503);
    await expect(down.json()).resolves.toMatchObject({ error: { code: 'unavailable' } });
    issuer.failDiscovery = false;
    const back = await logIn(server, { sub: 'u1', groups: ['petalbot-owners'] });
    expect(back.status).toBe(302);
    await server.close();
  });
});

describe('dev auth and sessions', () => {
  it('logs in without a provider when PETALBOT_DEV_AUTH is set', async () => {
    const server = await createTestServer();
    const login = await server.request('/auth/login?returnTo=/dashboard', { as: 'anonymous' });
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('/dashboard');
    const me = await server.request('/api/me', {
      as: 'anonymous',
      headers: { cookie: `${SESSION_COOKIE}=${cookiesOf(login)[SESSION_COOKIE] ?? ''}` },
    });
    await expect(me.json()).resolves.toEqual({
      user: { id: 'dev', name: 'dev', role: 'owner' },
      devAuth: true,
    });
    await server.close();
  });

  it('only returns to same-origin paths', async () => {
    const server = await createTestServer();
    const targets = [
      '//evil.example',
      'https://evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/\t\\evil.example',
      '/\n/evil.example',
    ];
    for (const target of targets) {
      const login = await server.request(`/auth/login?returnTo=${encodeURIComponent(target)}`, {
        as: 'anonymous',
      });
      expect(login.headers.get('location')).toBe('/');
    }
    await server.close();
  });

  it('logs out only from the own origin and revokes the session', async () => {
    const server = await createTestServer();
    const cookie = server.cookieFor({ id: 'u1', name: 'roman', role: 'owner' });
    const crossSite = await server.request('/auth/logout', {
      method: 'POST',
      as: 'anonymous',
      origin: 'https://evil.example',
      headers: { cookie },
    });
    expect(crossSite.status).toBe(403);
    const noOrigin = await server.request('/auth/logout', {
      method: 'POST',
      as: 'anonymous',
      origin: null,
      headers: { cookie },
    });
    expect(noOrigin.status).toBe(403);
    const logout = await server.request('/auth/logout', {
      method: 'POST',
      as: 'anonymous',
      headers: { cookie },
    });
    expect(logout.status).toBe(204);
    const me = await server.request('/api/me', { as: 'anonymous', headers: { cookie } });
    expect(me.status).toBe(401);
    await server.close();
  });

  it('marks cookies Secure when the public URL is https', async () => {
    const server = await createTestServer({ config: { publicUrl: 'https://localhost:8443' } });
    const login = await server.request('/auth/login', { as: 'anonymous' });
    expect(login.headers.getSetCookie().join('\n')).toMatch(
      /petalbot_session=[^;]+;.*HttpOnly.*Secure.*SameSite=Lax/,
    );
    await server.close();
  });
});
describe('login failures in a browser', () => {
  const html = { accept: 'text/html,application/xhtml+xml' };

  it('redirect to the panel error page instead of answering JSON', async () => {
    const server = await oidcServer();
    issuer.failDiscovery = true;
    const down = await server.request('/auth/login', { as: 'anonymous', headers: html });
    expect(down.status).toBe(302);
    expect(down.headers.get('location')).toBe('/login-error?reason=unavailable');
    issuer.failDiscovery = false;

    const expired = await server.request('/auth/callback?code=x&state=y', {
      as: 'anonymous',
      headers: html,
    });
    expect(expired.headers.get('location')).toBe('/login-error?reason=expired');

    const login = await server.request('/auth/login', { as: 'anonymous' });
    const query = issuer.approve(login.headers.get('location') ?? '', {
      sub: 'u3',
      groups: ['users'],
    });
    const stranger = await server.request(`/auth/callback?${query}`, {
      as: 'anonymous',
      headers: { ...html, cookie: `${LOGIN_COOKIE}=${cookiesOf(login)[LOGIN_COOKIE] ?? ''}` },
    });
    expect(stranger.status).toBe(302);
    expect(stranger.headers.get('location')).toBe('/login-error?reason=forbidden');
    await server.close();
  });
});
