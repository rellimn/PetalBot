import * as client from 'openid-client';
import { errorMessage } from '../../names.ts';

export interface OidcClientOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post';
  readonly scopes: readonly string[];
  /** `<publicUrl>/auth/callback`; registered at the provider. */
  readonly redirectUri: string;
  /** Allow an http:// issuer. Tests only. */
  readonly allowInsecureRequests?: boolean;
}

/** State kept between /auth/login and /auth/callback. */
export interface PendingLogin {
  readonly verifier: string;
  readonly state: string;
  readonly nonce: string;
  readonly returnTo: string;
}

export interface OidcIdentity {
  /** The provider's `sub`. */
  readonly id: string;
  readonly name: string;
  readonly groups: readonly string[];
}

/** The provider cannot be reached (login answers 503, the next attempt retries discovery). */
export class OidcUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OidcUnavailableError';
  }
}

/** The provider's answer failed a check (state, nonce, PKCE, signature). */
export class OidcLoginError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OidcLoginError';
  }
}

const TIMEOUT_SECONDS = 10;

/** Authorization-code flow with PKCE, state and nonce. Discovery is lazy. */
export class OidcClient {
  readonly redirectUri: string;
  readonly #options: OidcClientOptions;
  #configuration: Promise<client.Configuration> | undefined;

  constructor(options: OidcClientOptions) {
    this.#options = options;
    this.redirectUri = options.redirectUri;
  }

  async start(returnTo: string): Promise<{ readonly url: string; readonly pending: PendingLogin }> {
    const config = await this.#config();
    const verifier = client.randomPKCECodeVerifier();
    const pending: PendingLogin = {
      verifier,
      state: client.randomState(),
      nonce: client.randomNonce(),
      returnTo,
    };
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: this.#options.scopes.join(' '),
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: pending.state,
      nonce: pending.nonce,
    });
    return { url: url.href, pending };
  }

  /** `callbackUrl` must be the public callback URL with the provider's query string. */
  async finish(callbackUrl: URL, pending: PendingLogin): Promise<OidcIdentity> {
    const config = await this.#config();
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: pending.verifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
    } catch (error) {
      throw new OidcLoginError(`Login failed: ${errorMessage(error)}`, { cause: error });
    }
    const claims = tokens.claims();
    if (!claims) throw new OidcLoginError('Login failed: the provider sent no ID token');
    // Authelia's claims policy may keep groups out of the ID token; userinfo has them.
    let info: Readonly<Record<string, unknown>> = {};
    try {
      info = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
    } catch {
      // Fall back to the ID token claims.
    }
    return {
      id: claims.sub,
      name:
        stringClaim(info.preferred_username) ??
        stringClaim(claims.preferred_username) ??
        stringClaim(info.name) ??
        stringClaim(claims.name) ??
        claims.sub,
      groups: groupsClaim(info.groups) ?? groupsClaim(claims.groups) ?? [],
    };
  }

  #config(): Promise<client.Configuration> {
    this.#configuration ??= this.#discover();
    return this.#configuration;
  }

  async #discover(): Promise<client.Configuration> {
    const { issuer, clientId, clientSecret, tokenEndpointAuthMethod } = this.#options;
    const auth =
      tokenEndpointAuthMethod === 'client_secret_post'
        ? client.ClientSecretPost(clientSecret)
        : client.ClientSecretBasic(clientSecret);
    try {
      return await client.discovery(new URL(issuer), clientId, undefined, auth, {
        timeout: TIMEOUT_SECONDS,
        ...(this.#options.allowInsecureRequests === true
          ? // eslint-disable-next-line @typescript-eslint/no-deprecated -- tests use an http:// issuer
            { execute: [client.allowInsecureRequests] }
          : {}),
      });
    } catch (error) {
      this.#configuration = undefined; // the next login retries
      throw new OidcUnavailableError(`The login provider is unreachable: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function groupsClaim(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((group) => typeof group === 'string')
    ? value
    : undefined;
}
