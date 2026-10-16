import type { Failure } from '@petalbot/sdk';
import type { SendResult } from './contract.ts';

export function presentSendFailure(failure: Extract<SendResult, Failure>): string | undefined {
  switch (failure.error.code) {
    case 'send-vetoed':
      return 'Message blocked by a chat rule.';
    case 'connection-not-found':
      return 'This chat connection is no longer available. Choose another connection.';
    case 'ambiguous-target':
      return 'Choose a chat connection before sending.';
    default:
      return undefined;
  }
}
