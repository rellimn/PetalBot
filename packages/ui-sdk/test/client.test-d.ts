import { Quote } from 'lucide-react';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineContract, Result } from '@petalbot/sdk';
import type { ClientError } from '../src/client/errors.ts';
import { createPluginClient } from '../src/client/plugin-client.ts';
import { definePanel } from '../src/panel.ts';

const chat = defineContract({
  id: 'chat',
  version: '1.0.0',
  events: {
    message: { schema: z.object({ text: z.string() }), expose: ['panel'] },
    secret: { schema: z.object({}) },
    overlayOnly: { schema: z.object({}), expose: ['overlay'] },
  },
  rpc: {
    send: {
      input: z.object({ text: z.string() }),
      output: Result(z.object({ messageId: z.string() })),
      expose: { panel: 'mod' },
    },
    internal: { input: z.object({}), output: z.object({}) },
    ovl: { input: z.object({}), output: z.object({}), expose: { overlay: true } },
  },
});

const quotes = defineContract({
  id: 'quotes',
  version: '1.0.0',
  events: {
    added: {
      schema: z.object({ id: z.string(), at: z.coerce.date() }),
      expose: ['panel', 'overlay'],
    },
  },
  rpc: {
    list: {
      input: z.object({ limit: z.number().default(10) }),
      output: z.array(z.string()),
      expose: { panel: 'owner' },
    },
  },
});

const bare = defineContract({ id: 'bare', version: '1.0.0' });

describe('createPluginClient', () => {
  it('types only panel-exposed members of the contract and its dependencies', () => {
    const client = createPluginClient(quotes, [chat]);
    expectTypeOf(client.pluginId).toEqualTypeOf<string>();
    client.useEvent('quotes.added', (event) => {
      expectTypeOf(event.payload).toEqualTypeOf<{ id: string; at: Date }>();
      expectTypeOf(event.name).toEqualTypeOf<'quotes.added'>();
    });
    client.useEvent('chat.message', (event) => {
      expectTypeOf(event.payload).toEqualTypeOf<{ text: string }>();
    });
    // @ts-expect-error -- not exposed
    client.useEvent('chat.secret', () => undefined);
    // @ts-expect-error -- exposed to overlays only
    client.useEvent('chat.overlayOnly', () => undefined);

    const list = client.useRpc('quotes.list', {});
    expectTypeOf(list.data).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(list.error).toEqualTypeOf<ClientError | null>();
    const send = client.useMutation('chat.send');
    expectTypeOf(send.mutate).parameter(0).toEqualTypeOf<{ text: string }>();
    // @ts-expect-error -- not exposed
    void client.call('chat.internal', {});
    // @ts-expect-error -- exposed to overlays only
    void client.call('chat.ovl', {});
    // @ts-expect-error -- wrong input
    void client.call('chat.send', { text: 1 });
    expectTypeOf(client.call('chat.send', { text: 'x' })).resolves.toEqualTypeOf<
      | { ok: true; messageId: string }
      | {
          ok: false;
          reason: 'unsupported' | 'forbidden' | 'not-found' | 'rate-limited' | 'platform-error';
          message: string;
        }
    >();
  });

  it('works without dependencies and for contracts with nothing exposed', () => {
    const none = createPluginClient(bare);
    // @ts-expect-error -- nothing is exposed
    none.useEvent('bare.x', () => undefined);
    const own = createPluginClient(quotes);
    own.useEvent('quotes.added', () => undefined);
    // @ts-expect-error -- not a declared dependency
    own.useEvent('chat.message', () => undefined);
  });

  it('types live options from the client events and the RPC output', () => {
    const client = createPluginClient(quotes, [chat]);
    client.useRpc(
      'quotes.list',
      {},
      {
        refreshOn: ['chat.message'],
        update: {
          'quotes.added': (ids, event) => {
            expectTypeOf(ids).toEqualTypeOf<string[]>();
            expectTypeOf(event.payload).toEqualTypeOf<{ id: string; at: Date }>();
            return [...ids, event.payload.id];
          },
        },
      },
    );
    // @ts-expect-error -- not exposed to the panel
    client.useRpc('quotes.list', {}, { refreshOn: ['chat.secret'] });
    client.useRpc(
      'quotes.list',
      {},
      {
        // @ts-expect-error -- must return the RPC's output type
        update: { 'chat.message': () => 1 },
      },
    );
  });
});

describe('definePanel', () => {
  it('accepts lucide icons and components and rejects bad roles', () => {
    const Page = () => null;
    definePanel(quotes, {
      pages: [{ path: 'list', title: 'Quotes', icon: Quote, minRole: 'mod', component: Page }],
      widgets: [{ id: 'latest', title: 'Latest quote', component: Page }],
    });
    definePanel(quotes, {
      // @ts-expect-error -- not a role
      pages: [{ path: 'list', title: 'Quotes', minRole: 'viewer', component: Page }],
    });
  });
});
