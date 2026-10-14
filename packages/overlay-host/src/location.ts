const PAGE = /^\/overlay\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)\/([^/]+)$/;

export interface OverlayAddress {
  readonly pluginId: string;
  readonly overlay: string;
  readonly instanceId: string;
  /** OBS uses the instance token; the panel's preview uses the owner's session. */
  readonly credential:
    { readonly kind: 'token'; readonly token: string } | { readonly kind: 'preview' };
}

/** `/overlay/<plugin>/<overlay>/<instance>` (the host's own files live under `/overlay/_/`). */
export function isOverlayPage(path: string): boolean {
  return PAGE.test(path);
}

export function parseOverlayAddress(location: {
  readonly pathname: string;
  readonly search: string;
}): OverlayAddress | undefined {
  const match = PAGE.exec(location.pathname);
  const [, pluginId, overlay, rawId] = match ?? [];
  if (pluginId === undefined || overlay === undefined || rawId === undefined) return undefined;
  let instanceId: string;
  try {
    instanceId = decodeURIComponent(rawId);
  } catch {
    return undefined;
  }
  const params = new URLSearchParams(location.search);
  const token = params.get('t');
  if (token !== null && token !== '') {
    return { pluginId, overlay, instanceId, credential: { kind: 'token', token } };
  }
  if (params.has('preview')) {
    return { pluginId, overlay, instanceId, credential: { kind: 'preview' } };
  }
  return undefined;
}

export function overlaySocketUrl(
  location: { readonly protocol: string; readonly host: string },
  address: OverlayAddress,
): string {
  const query =
    address.credential.kind === 'token'
      ? `t=${encodeURIComponent(address.credential.token)}`
      : `preview=${encodeURIComponent(address.instanceId)}`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${query}`;
}
