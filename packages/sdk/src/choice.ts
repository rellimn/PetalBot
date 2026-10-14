import { z } from 'zod';

/** Metadata (and JSON Schema) key naming the RPC that lists a field's valid values. */
export const CHOICE_META_KEY = 'x-petalbot-choices';

declare const choiceRpc: unique symbol;

/** A string field whose valid values come from an RPC at runtime (see {@link choice}). */
export type Choice<Rpc extends string = string> = z.ZodString & { readonly [choiceRpc]: Rpc };

/** Output schema of an RPC named by {@link choice}: `[{ value, label }]`. */
export const Choices = z.array(z.object({ value: z.string(), label: z.string() }));
export type ChoiceList = z.output<typeof Choices>;

/**
 * A field whose valid values the plugin only knows at runtime, e.g. one of the counters a user
 * created. `rpc` names an own RPC without input, with output {@link Choices} and `expose.panel`;
 * generated forms render a select filled by it. The server only checks that the value is a string.
 * Allowed in top-level fields of `settings`, widget `config` and overlay `config`.
 */
export function choice<const Rpc extends string>(rpc: Rpc): Choice<Rpc> {
  return z.string().meta({ [CHOICE_META_KEY]: rpc }) as Choice<Rpc>;
}

/** The RPC a {@link choice} field names, looking through default, optional and nullable. */
export function choiceOf(schema: z.core.$ZodType): string | undefined {
  const rpc = z.globalRegistry.get(schema)?.[CHOICE_META_KEY];
  if (typeof rpc === 'string') return rpc;
  const def: object = schema._zod.def;
  const inner = 'innerType' in def ? def.innerType : undefined;
  return typeof inner === 'object' && inner !== null && '_zod' in inner
    ? choiceOf(inner as z.core.$ZodType)
    : undefined;
}
