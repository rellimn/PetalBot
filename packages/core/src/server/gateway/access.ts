import type { ContractShape, EventDef, OverlayDef, RpcDef } from '@petalbot/sdk';
import type { Owned } from '../../contract-registry.ts';
import { ownerOf } from '../../names.ts';
import { hasRole } from '../../roles.ts';
import type { ClientIdentity } from '../identity.ts';

/** What the access checks need to know about running contracts (the Kernel implements it). */
export interface ContractLookup {
  contract(pluginId: string): ContractShape | undefined;
  eventDef(name: string): Owned<EventDef> | undefined;
  rpcDef(name: string): Owned<RpcDef> | undefined;
}

interface Denied {
  readonly ok: false;
  readonly code: 'forbidden' | 'not_found' | 'unavailable';
  readonly message: string;
}
export type Access = { readonly ok: true } | Denied;

const OK: Access = { ok: true };
const deny = (code: Denied['code'], message: string): Denied => ({ ok: false, code, message });

type OverlayIdentity = Extract<ClientIdentity, { kind: 'overlay' }>;

/** The overlay's declaration, if its plugin runs and still declares it. */
function overlayScope(
  identity: OverlayIdentity,
  lookup: ContractLookup,
): { readonly ok: true; readonly def: OverlayDef } | Denied {
  const contract = lookup.contract(identity.pluginId);
  if (!contract) return deny('unavailable', `Plugin "${identity.pluginId}" is not running`);
  const overlays = contract.overlays ?? {};
  const def = Object.hasOwn(overlays, identity.overlay) ? overlays[identity.overlay] : undefined;
  if (!def) return deny('forbidden', `Overlay "${identity.overlay}" no longer exists`);
  return { ok: true, def };
}

function missing(name: string, what: string, lookup: ContractLookup): Denied {
  const owner = ownerOf(name);
  if (owner !== undefined && lookup.contract(owner) === undefined) {
    return deny('unavailable', `Plugin "${owner}" is not running`);
  }
  return deny('not_found', `Unknown ${what} "${name}"`);
}

/** May `identity` subscribe to (and receive) event `name`? */
export function checkSubscribe(
  identity: ClientIdentity,
  name: string,
  lookup: ContractLookup,
): Access {
  if (identity.kind === 'overlay') {
    const scope = overlayScope(identity, lookup);
    if (!scope.ok) return scope;
    if (!scope.def.events.includes(name)) {
      return deny('forbidden', `Overlay "${identity.overlay}" does not declare event "${name}"`);
    }
  }
  const event = lookup.eventDef(name);
  if (!event) return missing(name, 'event', lookup);
  if (!(event.def.expose ?? []).includes(identity.kind)) {
    return deny('forbidden', `Event "${name}" is not exposed to ${identity.kind}`);
  }
  return OK;
}

/** May `identity` call RPC `name`? */
export function checkCall(identity: ClientIdentity, name: string, lookup: ContractLookup): Access {
  if (identity.kind === 'overlay') {
    const scope = overlayScope(identity, lookup);
    if (!scope.ok) return scope;
    if (!scope.def.rpc.includes(name)) {
      return deny('forbidden', `Overlay "${identity.overlay}" does not declare RPC "${name}"`);
    }
  }
  const rpc = lookup.rpcDef(name);
  if (!rpc) return missing(name, 'RPC', lookup);
  if (identity.kind === 'overlay') {
    return rpc.def.expose?.overlay === true
      ? OK
      : deny('forbidden', `RPC "${name}" is not exposed to overlays`);
  }
  const required = rpc.def.expose?.panel;
  if (required === undefined) return deny('forbidden', `RPC "${name}" is not exposed to the panel`);
  if (!hasRole(identity.user.role, required)) {
    return deny('forbidden', `RPC "${name}" requires the role ${required}`);
  }
  return OK;
}
