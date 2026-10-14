import type { UseQueryResult } from '@tanstack/react-query';
import { useDeclaredQuery, type ClientError } from '@petalbot/ui-sdk';

export interface Choice {
  readonly value: string;
  readonly label: string;
}

/**
 * The choices a `choice()` field's RPC lists. Uses the plugin client's own query definition for
 * that RPC (refreshOn/update), so labels stay as live as in the plugin's components.
 */
export function useChoices(
  rpc: string | undefined,
): UseQueryResult<readonly Choice[], ClientError> {
  // Undefined: the caller has no choice field (hooks can't be called conditionally).
  return useDeclaredQuery(rpc ?? '', undefined, { enabled: rpc !== undefined }) as UseQueryResult<
    readonly Choice[],
    ClientError
  >;
}
