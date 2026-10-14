import { describe, expectTypeOf, it } from 'vitest';
import type { PanelUser, RpcClient } from '../src/identity.ts';
import { definePlugin } from '../src/plugin.ts';
import type { Disposer } from '../src/type-utils.ts';
import { bareContract, quotesContract } from './fixtures.ts';

describe('ctx.http.route', () => {
  it('types handlers with the Web Request and Response', () => {
    definePlugin(bareContract, {
      setup(ctx) {
        const dispose = ctx.http.route(
          'POST',
          '/webhook/:id',
          async (request, info) => {
            expectTypeOf(request).toEqualTypeOf<Request>();
            expectTypeOf(info.user).toEqualTypeOf<PanelUser | undefined>();
            expectTypeOf(info.params).toEqualTypeOf<Readonly<Record<string, string>>>();
            return new Response(await request.text());
          },
          { public: true },
        );
        expectTypeOf(dispose).toEqualTypeOf<Disposer>();
      },
    });
  });

  it('rejects handlers without a Response, unsupported methods and unknown roles', () => {
    definePlugin(bareContract, {
      setup(ctx) {
        // @ts-expect-error -- a handler must return a Response
        ctx.http.route('GET', '/text', () => 'text');
        // @ts-expect-error -- TRACE is not supported
        ctx.http.route('TRACE', '/x', () => new Response());
        // @ts-expect-error -- roles are owner or mod
        ctx.http.route('GET', '/x', () => new Response(), { role: 'admin' });
      },
    });
  });
});

describe('RPC meta', () => {
  it('tells implementations whether a browser made the call', () => {
    definePlugin(quotesContract, {
      setup: () => ({
        rpc: {
          list: (_input, { caller, client }) => {
            expectTypeOf(caller).toEqualTypeOf<string>();
            expectTypeOf(client).toEqualTypeOf<RpcClient | undefined>();
            return [];
          },
        },
      }),
    });
  });
});
