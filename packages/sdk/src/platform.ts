import { z } from 'zod';

/** `twitch`, `youtube`, ...: open, so a new platform changes no union. */
export const PlatformId = z.string().regex(/^[a-z][a-z0-9-]*$/);
export type PlatformId = z.output<typeof PlatformId>;

/** `<platform>:<channel>`, e.g. `twitch:roman`. */
export const ConnectionId = z.string().regex(/^[a-z][a-z0-9-]*:.+$/);
export type ConnectionId = z.output<typeof ConnectionId>;

/** Where something came from. */
export const Source = z.object({ platform: PlatformId, connection: ConnectionId });
export type Source = z.output<typeof Source>;

/** Who to act on: a connection, or a platform's default connection. */
export const Target = z.union([
  z.object({ connection: ConnectionId }),
  z.object({ platform: PlatformId }),
]);
export type Target = z.output<typeof Target>;

/** A person on a platform. */
export const PlatformUser = z.object({
  /** The platform's stable user id. */
  id: z.string().min(1),
  login: z.string(),
  displayName: z.string(),
});
export type PlatformUser = z.output<typeof PlatformUser>;

/** A platform user together with the platform and channel they belong to. */
export const Viewer = PlatformUser.extend({ platform: PlatformId, connection: ConnectionId });
export type Viewer = z.output<typeof Viewer>;

/** Splits a connection id: `twitch:roman` -> `{ platform: 'twitch', connection: 'twitch:roman' }`. */
export function sourceOf(connection: string): Source {
  if (!ConnectionId.safeParse(connection).success) {
    throw new TypeError(`"${connection}" is not a connection id (<platform>:<channel>)`);
  }
  return { platform: connection.slice(0, connection.indexOf(':')), connection };
}
