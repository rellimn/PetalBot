import type { ContractShape, EventDef, HookDef, ProviderSlotDef, RpcDef } from '@petalbot/sdk';
import { splitName } from './names.ts';

export interface Owned<D> {
  readonly owner: string;
  readonly def: D;
}

/** Contracts of running plugins, keyed by plugin id (= contract id). */
export class ContractRegistry {
  readonly #contracts = new Map<string, ContractShape>();

  /** Registers a contract; returns its unregister function. */
  register(contract: ContractShape): () => void {
    if (this.#contracts.has(contract.id)) {
      throw new Error(`Contract "${contract.id}" is already registered`);
    }
    this.#contracts.set(contract.id, contract);
    return () => {
      if (this.#contracts.get(contract.id) === contract) this.#contracts.delete(contract.id);
    };
  }

  get(id: string): ContractShape | undefined {
    return this.#contracts.get(id);
  }

  event(name: string): Owned<EventDef> | undefined {
    return this.#lookup(name, (c) => c.events);
  }

  hook(name: string): Owned<HookDef> | undefined {
    return this.#lookup(name, (c) => c.hooks);
  }

  rpc(name: string): Owned<RpcDef> | undefined {
    return this.#lookup(name, (c) => c.rpc);
  }

  providerSlot(name: string): Owned<ProviderSlotDef> | undefined {
    return this.#lookup(name, (c) => c.providers);
  }

  #lookup<D>(
    name: string,
    group: (contract: ContractShape) => Readonly<Record<string, D>> | undefined,
  ): Owned<D> | undefined {
    const parts = splitName(name);
    if (!parts) return undefined;
    const [owner, member] = parts;
    const contract = this.#contracts.get(owner);
    if (!contract) return undefined;
    const members = group(contract);
    if (!members || !Object.hasOwn(members, member)) return undefined;
    const def = members[member];
    return def === undefined ? undefined : { owner, def };
  }
}
