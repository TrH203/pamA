// TanStack Query setup shared by the console pages. Client errors (4xx) are not retried: they
// will not fix themselves; network and 5xx errors get one retry.
import { QueryClient } from "@tanstack/react-query";
import { ApiError, api } from "./api.ts";

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 1,
      },
      mutations: { retry: false },
    },
  });
}

/** Query keys and fetchers used by more than one place (pages and sidebar counts). */
export const queries = {
  review: { queryKey: ["review"], queryFn: () => api<{ items: unknown[] }>("/v1/review") },
  inbox: { queryKey: ["inbox"], queryFn: () => api<{ items: unknown[] }>("/v1/inbox") },
  me: {
    queryKey: ["auth", "me"],
    queryFn: () => api<{ mode: string; dev?: boolean }>("/v1/auth/me"),
  },
} as const;
