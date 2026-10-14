import { QueryClient } from '@tanstack/react-query';
import { ApiError, ClientError } from '@petalbot/ui-sdk';

/** Only connection trouble is worth retrying; refusals and validation errors are final. */
function isTransient(error: unknown): boolean {
  if (error instanceof ClientError) return error.code === 'unavailable' || error.code === 'timeout';
  if (error instanceof ApiError) return error.status === 0 || error.status >= 500;
  return false;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failures, error) => failures < 3 && isTransient(error),
        staleTime: 5_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}
