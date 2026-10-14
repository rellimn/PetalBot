import { useEffect } from 'react';
import { useConnection } from '@petalbot/ui-sdk';
import { useSession } from './context.ts';

/** A socket closed with 4001 ends the session just like an HTTP 401. */
export function SessionSync() {
  const connection = useConnection();
  const session = useSession();
  useEffect(
    () =>
      connection.state.subscribe((state) => {
        if (state.status === 'ended') session.end();
      }),
    [connection, session],
  );
  return null;
}
