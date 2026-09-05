import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './api';

/**
 * Shared TanStack Query client.
 *
 * 401 recovery is not handled here — `apiFetch` already refreshes the access
 * token and retries the request once, so by the time an error surfaces to a
 * query the session is genuinely gone. Retrying 4xx here would only duplicate
 * that work, so client errors fail fast.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 1;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
