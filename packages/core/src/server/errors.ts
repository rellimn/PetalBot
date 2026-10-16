import { PetalBotError, type ErrorCode } from '@petalbot/sdk';

export type WireErrorCode =
  | 'invalid_message'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'unavailable'
  | 'timeout'
  | 'busy'
  | 'conflict'
  | 'confirmation_required'
  | 'auth_failed'
  | 'too_large'
  | 'internal';

/** What a browser may see of an error */
export interface WireError {
  readonly code: WireErrorCode;
  readonly message: string;
}

export type ApiStatus = 400 | 401 | 403 | 404 | 409 | 413 | 500 | 503;

/** An error meant for an HTTP client: its message is safe to show. */
export class ApiError extends Error {
  readonly status: ApiStatus;
  readonly code: WireErrorCode;
  /** Affected plugins, for `confirmation_required`. */
  readonly plugins: readonly string[] | undefined;

  constructor(
    status: ApiStatus,
    code: WireErrorCode,
    message: string,
    plugins?: readonly string[],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.plugins = plugins;
  }
}

const FROM_SDK: Readonly<Record<ErrorCode, WireErrorCode>> = {
  validation: 'validation',
  'plugin-unavailable': 'unavailable',
  'rpc-timeout': 'timeout',
  'provider-timeout': 'timeout',
  'unsupported-capability': 'unavailable',
  'contract-version': 'conflict',
  'access-denied': 'forbidden',
};

const STATUS: Readonly<Record<WireErrorCode, ApiStatus>> = {
  invalid_message: 400,
  validation: 400,
  auth_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  confirmation_required: 409,
  unavailable: 409,
  too_large: 413,
  internal: 500,
  timeout: 503,
  busy: 503,
};

/** PetalBot errors keep their message; anything else becomes a bare `internal`. */
export function toWireError(error: unknown): WireError {
  if (error instanceof ApiError) return { code: error.code, message: error.message };
  if (error instanceof PetalBotError) {
    return { code: FROM_SDK[error.code], message: error.message };
  }
  return { code: 'internal', message: 'Internal error' };
}

export function statusOf(code: WireErrorCode): ApiStatus {
  return STATUS[code];
}
