import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineContract } from '../src/contract.ts';
import { definePlugin } from '../src/plugin.ts';
import type { Disposer } from '../src/type-utils.ts';

const Token = z.object({ accessToken: z.string(), expiresAt: z.number().nullable() });

const vault = defineContract({
  id: 'vault',
  version: '1.0.0',
  secrets: {
    clientSecret: { userSettable: true, label: 'Client secret', description: 'From the app' },
    tokens: { schema: Token, keyed: true },
    plain: {},
    notes: { keyed: true },
  },
});

describe('secret declarations', () => {
  it('rejects malformed declarations', () => {
    defineContract({
      id: 'a',
      version: '1.0.0',
      // @ts-expect-error -- user-settable secrets need a label
      secrets: { key: { userSettable: true } },
    });
    defineContract({
      id: 'a',
      version: '1.0.0',
      // @ts-expect-error -- user-settable secrets are plain strings
      secrets: { key: { userSettable: true, label: 'Key', schema: z.number() } },
    });
    defineContract({
      id: 'a',
      version: '1.0.0',
      // @ts-expect-error -- keyed user-settable secrets are not built
      secrets: { key: { userSettable: true, label: 'Key', keyed: true } },
    });
  });
});

describe('ctx.secrets', () => {
  it('types single and keyed secrets from the declaration', () => {
    definePlugin(vault, {
      async setup(ctx) {
        expectTypeOf(await ctx.secrets.get('clientSecret')).toEqualTypeOf<string | undefined>();
        expectTypeOf(await ctx.secrets.get('plain')).toEqualTypeOf<string | undefined>();
        expectTypeOf(await ctx.secrets.get('tokens', '42')).toEqualTypeOf<
          { accessToken: string; expiresAt: number | null } | undefined
        >();
        expectTypeOf(await ctx.secrets.get('notes', 'a')).toEqualTypeOf<string | undefined>();
        // @ts-expect-error -- keyed secrets need a key
        await ctx.secrets.get('tokens');
        // @ts-expect-error -- single secrets take no key
        await ctx.secrets.get('plain', 'k');
        // @ts-expect-error -- undeclared
        await ctx.secrets.get('nope');

        await ctx.secrets.set('plain', 'v');
        await ctx.secrets.set('tokens', '42', { accessToken: 'a', expiresAt: null });
        // @ts-expect-error -- a plain secret is a string
        await ctx.secrets.set('plain', 1);
        // @ts-expect-error -- wrong value for the schema
        await ctx.secrets.set('tokens', '42', 'x');

        await ctx.secrets.delete('plain');
        await ctx.secrets.delete('tokens', '42');
        // @ts-expect-error -- keyed secrets need a key
        await ctx.secrets.delete('tokens');

        expectTypeOf(await ctx.secrets.keys('tokens')).toEqualTypeOf<string[]>();
        // @ts-expect-error -- only keyed secrets have keys
        await ctx.secrets.keys('plain');

        expectTypeOf(
          ctx.secrets.onChange('clientSecret', () => undefined),
        ).toEqualTypeOf<Disposer>();
        ctx.secrets.onChange('tokens', (key) => {
          expectTypeOf(key).toEqualTypeOf<string>();
        });
      },
    });
  });

  it('offers nothing when the contract declares no secrets', () => {
    definePlugin(defineContract({ id: 'bare', version: '1.0.0' }), {
      async setup(ctx) {
        // @ts-expect-error -- no secrets declared
        await ctx.secrets.get('token');
      },
    });
  });
});
