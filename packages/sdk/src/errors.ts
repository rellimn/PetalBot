import type { z } from 'zod';

export type ErrorCode =
  | 'validation'
  | 'plugin-unavailable'
  | 'rpc-timeout'
  | 'unsupported-capability'
  | 'contract-version'
  | 'access-denied';

/** Base class of all errors the SDK and core throw on purpose. */
export class PetalBotError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A payload, input or output did not match its schema. */
export class ValidationError extends PetalBotError {
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(subject: string, issues: readonly z.core.$ZodIssue[]) {
    const summary = issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    super('validation', `Invalid ${subject}: ${summary}`);
    this.issues = issues;
  }
}

/** The plugin that owns an RPC or provider slot is not running. */
export class PluginUnavailableError extends PetalBotError {
  readonly pluginId: string;

  constructor(pluginId: string) {
    super('plugin-unavailable', `Plugin "${pluginId}" is not running`);
    this.pluginId = pluginId;
  }
}

export class RpcTimeoutError extends PetalBotError {
  constructor(name: string, timeoutMs: number) {
    super('rpc-timeout', `RPC "${name}" timed out after ${String(timeoutMs)} ms`);
  }
}

/** A provider does not implement the requested method. Domains map this to Result 'unsupported'. */
export class UnsupportedCapabilityError extends PetalBotError {
  constructor(slot: string, key: string, method: string) {
    super(
      'unsupported-capability',
      `Provider "${key}" of "${slot}" does not implement "${method}"`,
    );
  }
}

export class ContractVersionError extends PetalBotError {
  constructor(message: string) {
    super('contract-version', message);
  }
}

/** A plugin used a name it has no access to (not its own contract, not a declared dependency). */
export class AccessError extends PetalBotError {
  constructor(message: string) {
    super('access-denied', message);
  }
}
