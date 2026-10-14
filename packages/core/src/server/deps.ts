import type { Logger } from '@petalbot/sdk';
import type { Kernel } from '../kernel.ts';
import type { LogRing } from '../log-ring.ts';
import type { PluginManager } from '../plugin-manager.ts';
import type { OidcClient } from './auth/oidc.ts';
import type { PendingLogins } from './auth/pending-logins.ts';
import type { SessionStore } from './auth/session-store.ts';
import type { ResolvedConfig } from './config.ts';
import type { EventLog } from './event-log.ts';
import type { OverlayInstanceStore } from './overlays/instance-store.ts';
import type { UserStore } from './users/user-store.ts';

/** Everything the HTTP routes use. */
export interface AppDeps {
  readonly config: ResolvedConfig;
  readonly logger: Logger;
  readonly kernel: Kernel;
  readonly manager: PluginManager;
  readonly sessions: SessionStore;
  readonly overlays: OverlayInstanceStore;
  readonly eventLog: EventLog;
  readonly users: UserStore;
  readonly logs: LogRing;
  readonly pendingLogins: PendingLogins;
  /** Undefined under dev auth. */
  readonly oidc: OidcClient | undefined;
}
