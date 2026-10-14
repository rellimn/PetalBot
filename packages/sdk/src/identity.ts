import type { Role } from './contract.ts';

/** A user logged into the panel. */
export interface PanelUser {
  /** Stable subject id from the login provider (`dev` under dev auth). */
  readonly id: string;
  readonly name: string;
  readonly role: Role;
}

/** Who made an RPC call from a browser. */
export type RpcClient =
  | { readonly kind: 'panel'; readonly user: PanelUser }
  | { readonly kind: 'overlay'; readonly instanceId: string };
