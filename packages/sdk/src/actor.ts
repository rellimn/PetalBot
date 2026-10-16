import { z } from 'zod';
import { Viewer } from './platform.ts';

export const PanelUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['owner', 'mod']),
});

/** Who caused something: a panel user, an overlay, a plugin, a chat viewer or a flow. */
export const Actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), user: PanelUserSchema }),
  z.object({ kind: z.literal('overlay'), instanceId: z.string() }),
  z.object({ kind: z.literal('plugin'), pluginId: z.string() }),
  z.object({ kind: z.literal('viewer'), viewer: Viewer }),
  z.object({ kind: z.literal('flow'), flowId: z.string(), name: z.string() }),
]);
export type Actor = z.output<typeof Actor>;

/** What made a call on the actor's behalf. */
export const Via = z.object({
  kind: z.literal('flow'),
  flowId: z.string(),
  name: z.string(),
  runId: z.string(),
});
export type Via = z.output<typeof Via>;

/** A display label: the panel user's name, `'overlay'`, the plugin id, the viewer's or flow's name. */
export function describeActor(actor: Actor): string {
  switch (actor.kind) {
    case 'user':
      return actor.user.name;
    case 'overlay':
      return 'overlay';
    case 'plugin':
      return actor.pluginId;
    case 'viewer':
      return actor.viewer.displayName;
    case 'flow':
      return actor.name;
  }
}
