import { describe, expect, it } from 'vitest';
import { ContractRegistry } from '../../src/contract-registry.ts';
import { checkCall, checkSubscribe, type ContractLookup } from '../../src/server/gateway/access.ts';
import type { ClientIdentity } from '../../src/server/identity.ts';
import { alertsContract, modUser, ownerUser } from './fixtures.ts';

const registry = new ContractRegistry();
registry.register(alertsContract);
const lookup: ContractLookup = {
  contract: (id) => registry.get(id),
  eventDef: (name) => registry.event(name),
  rpcDef: (name) => registry.rpc(name),
};

const owner: ClientIdentity = { kind: 'panel', sessionId: 's1', user: ownerUser };
const mod: ClientIdentity = { kind: 'panel', sessionId: 's2', user: modUser };
const overlay = {
  kind: 'overlay',
  instanceId: 'i1',
  pluginId: 'alerts',
  overlay: 'box',
} as const satisfies ClientIdentity;
const gone: ClientIdentity = { ...overlay, overlay: 'removed' };
const stopped: ClientIdentity = { ...overlay, pluginId: 'quotes' };

const codeOf = (access: ReturnType<typeof checkSubscribe>) => (access.ok ? 'ok' : access.code);

describe('checkSubscribe', () => {
  it.each([
    [mod, 'alerts.shown', 'ok'],
    [mod, 'alerts.internal', 'forbidden'],
    [mod, 'alerts.nope', 'not_found'],
    [mod, 'chat.message', 'unavailable'],
    [mod, 'malformed', 'not_found'],
    [overlay, 'alerts.shown', 'ok'],
    [overlay, 'alerts.internal', 'forbidden'],
    [gone, 'alerts.shown', 'forbidden'],
    [stopped, 'alerts.shown', 'unavailable'],
  ] as const)('%#: %o subscribing to %s -> %s', (identity, name, expected) => {
    expect(codeOf(checkSubscribe(identity, name, lookup))).toBe(expected);
  });
});

describe('checkCall', () => {
  it.each([
    [mod, 'alerts.recent', 'ok'],
    [mod, 'alerts.clear', 'forbidden'],
    [owner, 'alerts.clear', 'ok'],
    [owner, 'alerts.hidden', 'forbidden'],
    [owner, 'alerts.nope', 'not_found'],
    [owner, 'chat.send', 'unavailable'],
    [overlay, 'alerts.recent', 'ok'],
    [overlay, 'alerts.clear', 'forbidden'],
    [stopped, 'alerts.recent', 'unavailable'],
  ] as const)('%#: %o calling %s -> %s', (identity, name, expected) => {
    expect(codeOf(checkCall(identity, name, lookup))).toBe(expected);
  });
});
