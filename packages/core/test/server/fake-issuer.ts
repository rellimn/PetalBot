import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

export const CLIENT_ID = 'petalbot';
export const CLIENT_SECRET = 'test-client-secret';

export interface FakeUser {
  readonly sub: string;
  readonly groups: readonly string[];
  readonly name?: string;
}

export interface FakeIssuer {
  readonly url: string;
  /** Simulates the user approving the login; returns the callback query string. */
  approve(authorizationUrl: string, user: FakeUser): string;
  /** While true, discovery answers 500. */
  failDiscovery: boolean;
  close(): Promise<void>;
}

interface PendingCode {
  readonly challenge: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly user: FakeUser;
}

/** A minimal OIDC provider: discovery, JWKS, token (PKCE + client_secret_basic), userinfo. */
export async function startFakeIssuer(): Promise<FakeIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, PendingCode>();
  const accessTokens = new Map<string, FakeUser>();
  const state = { failDiscovery: false, url: '' };

  async function handle(request: IncomingMessage): Promise<[number, unknown]> {
    const path = new URL(request.url ?? '/', state.url).pathname;
    if (path === '/.well-known/openid-configuration') {
      if (state.failDiscovery) return [500, { error: 'down' }];
      return [
        200,
        {
          issuer: state.url,
          authorization_endpoint: `${state.url}/authorize`,
          token_endpoint: `${state.url}/token`,
          jwks_uri: `${state.url}/jwks`,
          userinfo_endpoint: `${state.url}/userinfo`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        },
      ];
    }
    if (path === '/jwks') return [200, { keys: [jwk] }];
    if (path === '/userinfo') {
      const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
      const user = accessTokens.get(token);
      if (!user) return [401, { error: 'invalid_token' }];
      return [
        200,
        { sub: user.sub, preferred_username: user.name ?? user.sub, groups: user.groups },
      ];
    }
    if (path === '/token') {
      // RFC 6749 §2.3.1: id and secret are form-encoded before the Basic encoding.
      const basic = Buffer.from(
        (request.headers.authorization ?? '').replace(/^Basic /, ''),
        'base64',
      ).toString('utf8');
      const [id = '', secret = ''] = basic.split(':').map((part) => decodeURIComponent(part));
      if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return [401, { error: 'invalid_client' }];
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const params = new URLSearchParams(body);
      const code = params.get('code') ?? '';
      const entry = codes.get(code);
      const verifier = params.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!entry) return [400, { error: 'invalid_grant' }];
      if (params.get('redirect_uri') !== entry.redirectUri || challenge !== entry.challenge) {
        return [400, { error: 'invalid_grant' }];
      }
      codes.delete(code);
      const accessToken = `access-${String(accessTokens.size)}`;
      accessTokens.set(accessToken, entry.user);
      const idToken = await new SignJWT({ nonce: entry.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(state.url)
        .setAudience(CLIENT_ID)
        .setSubject(entry.user.sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return [
        200,
        { access_token: accessToken, token_type: 'Bearer', id_token: idToken, expires_in: 300 },
      ];
    }
    return [404, { error: 'not_found' }];
  }

  const server = createServer((request, response) => {
    void handle(request).then(([status, body]) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  state.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    url: state.url,
    get failDiscovery() {
      return state.failDiscovery;
    },
    set failDiscovery(value: boolean) {
      state.failDiscovery = value;
    },
    approve(authorizationUrl, user) {
      const params = new URL(authorizationUrl).searchParams;
      const code = `code-${String(codes.size)}-${user.sub}`;
      codes.set(code, {
        challenge: params.get('code_challenge') ?? '',
        nonce: params.get('nonce') ?? '',
        redirectUri: params.get('redirect_uri') ?? '',
        user,
      });
      return new URLSearchParams({ code, state: params.get('state') ?? '' }).toString();
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
