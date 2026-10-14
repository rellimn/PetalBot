/**
 * Host-only APIs for the panel itself (`@petalbot/ui-sdk/host`). Not part of the plugin API:
 * the entry isn't in the import map, so plugin bundles can't share it.
 */
import type { UseQueryResult } from '@tanstack/react-query';
import type { ClientError } from './client/errors.ts';
import { useDeclaredQuery } from './client/plugin-client.ts';

/** One value a `choice()` field may take, as its RPC lists it. */
export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The choices a `choice()` field's RPC lists, for generated forms and widget titles. Live with
 * the owner's client definition once its panel bundle is loaded; a plain query for a plugin
 * without a panel. `rpc` must come from `choice()` metadata: the contract checks guarantee that
 * it names a query. `undefined` (no choice field) sends nothing; hooks can't be conditional.
 */
export function useChoices(
  rpc: string | undefined,
): UseQueryResult<readonly ChoiceOption[], ClientError> {
  return useDeclaredQuery(rpc ?? '', undefined, { enabled: rpc !== undefined }) as UseQueryResult<
    readonly ChoiceOption[],
    ClientError
  >;
}
