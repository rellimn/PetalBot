import type { PanelUser } from '@petalbot/sdk';

/** Who is on the other end of a WebSocket, fixed at the upgrade. */
export type ClientIdentity =
  | { readonly kind: 'panel'; readonly sessionId: string; readonly user: PanelUser }
  | {
      readonly kind: 'overlay';
      readonly instanceId: string;
      readonly pluginId: string;
      readonly overlay: string;
      /** Set for the panel's live preview: the owner session it runs on (instead of the token). */
      readonly sessionId?: string;
    };
