/**
 * The counter's server side: its storage, its RPCs and its events.
 *
 * Runs in Node inside the PetalBot core. It may import the contract, the Drizzle schema and
 * Node built-ins; panel and overlay code never import this file.
 *
 * Guide: docs/plugin-guide.md#4-the-server.
 * Read next: src/client.ts.
 */
import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { ValidationError, definePlugin, fail, ok } from '@petalbot/sdk';
import { counterContract, type Counter } from './contract.ts';
import { counters } from './db/schema.ts';

type Row = typeof counters.$inferSelect;

/** Maps a table row to the contract's shape (see `Counter` in contract.ts for why they differ). */
const toCounter = (row: Row): Counter => ({ id: row.id, name: row.name, value: row.value });

export default definePlugin(counterContract, {
  // Migrations are read from ./drizzle (the default), relative to the plugin folder.
  db: { schema: { counters } },

  // setup runs on every start (enable, reload). Whatever it returns as `rpc` becomes callable
  // once it has finished, so RPCs never see a half-initialized plugin.
  setup(ctx) {
    ctx.log.info('Counter ready', { step: ctx.settings.get().step });

    const notFound = (id: string) => fail('not-found', `There is no counter "${id}"`);

    /** Announces a changed value and builds the RPC result. */
    const changed = (row: Row, by: string) => {
      // Emit after the write: anyone reacting to the event must already see the new value
      // (see docs/plugin-guide.md#10-watch-out-for).
      ctx.emit('counter.changed', { counter: row.id, value: row.value, by });
      return ok({ counter: toCounter(row) });
    };

    const all = () => ctx.db.select().from(counters).orderBy(asc(counters.name)).all();

    return {
      rpc: {
        list: () => all().map(toCounter),

        options: () => all().map((row) => ({ value: row.id, label: row.name })),

        get: ({ counter }) => {
          const row = ctx.db.select().from(counters).where(eq(counters.id, counter)).get();
          return row ? toCounter(row) : null;
        },

        // `who` is a label for the caller: the panel user's name, 'overlay', or a plugin id.
        increment: ({ counter }, { who }) => {
          // One UPDATE ... RETURNING statement reads and writes the value. Nothing can run in
          // between, unlike "read the value, await something, write value + step", which loses
          // clicks when two arrive at once (see docs/plugin-guide.md#10-watch-out-for).
          // Drizzle types `.get()` as always finding a row, but it's undefined when none matched.
          const row = ctx.db
            .update(counters)
            .set({ value: sql`${counters.value} + ${ctx.settings.get().step}` })
            .where(eq(counters.id, counter))
            .returning()
            .get() as Row | undefined;
          return row ? changed(row, who) : notFound(counter);
        },

        reset: ({ counter }, { who }) => {
          const row = ctx.db
            .update(counters)
            .set({ value: 0 })
            .where(eq(counters.id, counter))
            .returning()
            .get() as Row | undefined;
          return row ? changed(row, who) : notFound(counter);
        },

        create: ({ name }) => {
          // The name check and the insert run in one transaction, so two creates with the same
          // name can't both pass the check. A duplicate is the caller's mistake, so it throws a
          // ValidationError (the panel shows it on the name field) instead of returning a Result.
          const row = ctx.db.transaction((tx) => {
            const taken = tx
              .select({ id: counters.id })
              .from(counters)
              .where(eq(counters.name, name))
              .get();
            if (taken) {
              throw new ValidationError('counter name', [
                {
                  code: 'custom',
                  path: ['name'],
                  message: 'A counter with this name already exists',
                  input: name,
                },
              ]);
            }
            return tx
              .insert(counters)
              .values({ id: randomUUID(), name, value: 0, createdAt: new Date() })
              .returning()
              .get();
          });
          ctx.emit('counter.listChanged', {});
          return toCounter(row);
        },

        remove: ({ counter }) => {
          const row = ctx.db.delete(counters).where(eq(counters.id, counter)).returning().get();
          if (!row) return notFound(counter);
          ctx.emit('counter.listChanged', {});
          return ok({});
        },
      },
    };
  },
});
