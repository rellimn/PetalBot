/** A WebSocket request failed: the server's code, or unavailable/timeout/unauthorized. */
export class ClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
  }
}

export interface ApiIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** An HTTP request failed. `status` 0 with code `network`: the server was unreachable. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Affected plugins, for `confirmation_required`. */
  readonly plugins: readonly string[];
  /** Validation issues, for `validation`. */
  readonly issues: readonly ApiIssue[];

  constructor(
    status: number,
    code: string,
    message: string,
    plugins: readonly string[] = [],
    issues: readonly ApiIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.plugins = plugins;
    this.issues = issues;
  }
}
