import { useEffect, useState } from 'react';
import { Banner, useConnectionStatus } from '@petalbot/ui-sdk';

const DELAY_MS = 2000;

/** Appears once the connection has been gone for ~2 s; short blips stay invisible. */
export function ReconnectBanner() {
  const status = useConnectionStatus();
  return status === 'reconnecting' ? <DelayedBanner /> : null;
}

function DelayedBanner() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(true);
    }, DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return visible ? (
    <Banner tone="warning">Reconnecting… Live data may be out of date until then.</Banner>
  ) : null;
}
