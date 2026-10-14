/**
 * The counter's panel client: one typed handle per RPC and event, `api.counter.<member>`.
 *
 * Runs in the panel. Created once at module scope: the React Compiler needs the hooks behind it
 * to be the same functions on every render. The definition decides, once for every component,
 * which RPCs are read (`queries`) and how they stay fresh; everything else is a mutation.
 *
 * Read next: src/panel.tsx.
 */
import { createPluginClient } from '@petalbot/ui-sdk';
import { counterContract } from './contract.ts';

export const api = createPluginClient(counterContract, {
  queries: {
    // `update` computes the new list from the event: no round trip per click. It must return
    // a new array (never mutate), because the cache and the React Compiler compare by reference.
    'counter.list': {
      refreshOn: ['counter.listChanged'],
      update: {
        'counter.changed': (list, event) =>
          list.map((item) =>
            item.id === event.payload.counter ? { ...item, value: event.payload.value } : item,
          ),
      },
    },
    // The choices behind the widget's counter picker: refetched when counters come and go.
    'counter.options': { refreshOn: ['counter.listChanged'] },
    // One entry per input: `input` tells this entry's counter, so only its own events change it.
    'counter.get': {
      refreshOn: ['counter.listChanged'],
      update: {
        'counter.changed': (data, event, input) =>
          data !== null && event.payload.counter === input.counter
            ? { ...data, value: event.payload.value }
            : data,
      },
    },
  },
  mutations: {
    // Events already keep every view live (in every tab), so a click needs no extra refetch.
    // Without `invalidates`, a mutation refetches all of the counter's queries in this tab.
    'counter.increment': { invalidates: [] },
    'counter.reset': { invalidates: [] },
  },
});
