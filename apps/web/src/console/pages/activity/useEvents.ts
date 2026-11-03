// Live updates from GET /v1/events (SSE): run.updated, review.count, inbox.count, heartbeat.
// Events invalidate the matching queries; while the stream is down, pages poll instead
// (`usePollInterval`). The stream reconnects with exponential backoff.
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import {
  ACTIVITY_KEY,
  activityQueries,
  type PipelineCounts,
  type Run,
  type RunPage,
} from "./api.ts";

export const POLL_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
const INVALIDATE_DEBOUNCE_MS = 400;

// --- connection state (shared by every component that asks) ------------------------------------
let live = false;
const listeners = new Set<() => void>();
function setLive(v: boolean) {
  if (live === v) return;
  live = v;
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** True while the event stream is connected. */
export function useLive(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => live,
    () => false,
  );
}

/** A refetch interval for pipeline queries: none while live, polling while the stream is down. */
export function usePollInterval(): number | false {
  return useLive() ? false : POLL_MS;
}

/** Exposed for tests. */
export function backoff(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, attempt - 1));
}

function parse<T>(data: unknown): T | null {
  try {
    return JSON.parse(String(data)) as T;
  } catch {
    return null;
  }
}

/** Apply one event to the query cache. Exported so tests can drive it without a stream. */
export function applyEvent(
  qc: QueryClient,
  type: string,
  data: unknown,
  invalidateRuns: () => void,
): void {
  switch (type) {
    case "run.updated": {
      const run = parse<Run>(data);
      if (run?.id) qc.setQueryData(activityQueries.run(run.id).queryKey, { run });
      invalidateRuns();
      break;
    }
    case "review.count": {
      const n = parse<Pick<PipelineCounts, "awaiting_review" | "failed">>(data);
      if (!n) break;
      qc.setQueryData<RunPage>(activityQueries.summary.queryKey, (old) =>
        old ? { ...old, counts: { ...old.counts, ...n } } : old,
      );
      void qc.invalidateQueries({ queryKey: ["review"] });
      invalidateRuns();
      break;
    }
    case "inbox.count": {
      const n = parse<Pick<PipelineCounts, "forwarded">>(data);
      if (n) {
        qc.setQueryData<RunPage>(activityQueries.summary.queryKey, (old) =>
          old ? { ...old, counts: { ...old.counts, ...n } } : old,
        );
      }
      void qc.invalidateQueries({ queryKey: ["inbox"] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      break;
    }
  }
}

/**
 * Open the event stream once for the console (mount it in the shell). Returns nothing: read the
 * state with `useLive()`; data arrives through the query cache.
 */
export function useEvents(url = "/v1/events"): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === "undefined") return; // polling only
    let es: EventSource | null = null;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    // Stage updates come in bursts: refresh the lists once per burst.
    const invalidateRuns = () => {
      clearTimeout(debounce);
      debounce = setTimeout(
        () => void qc.invalidateQueries({ queryKey: ACTIVITY_KEY }),
        INVALIDATE_DEBOUNCE_MS,
      );
    };

    const connect = () => {
      if (stopped) return;
      try {
        es = new EventSource(url, { withCredentials: true });
      } catch {
        setLive(false);
        return;
      }
      es.onopen = () => {
        const reconnected = attempt > 0;
        attempt = 0;
        setLive(true);
        // Events missed while disconnected: catch up once.
        if (reconnected) {
          void qc.invalidateQueries({ queryKey: ACTIVITY_KEY });
          void qc.invalidateQueries({ queryKey: ["review"] });
          void qc.invalidateQueries({ queryKey: ["inbox"] });
        }
      };
      es.onerror = () => {
        // Take over reconnecting so a 401/404 or a dropped proxy does not spin.
        es?.close();
        es = null;
        setLive(false);
        attempt += 1;
        retryTimer = setTimeout(connect, backoff(attempt));
      };
      for (const type of ["run.updated", "review.count", "inbox.count"]) {
        es.addEventListener(type, (e) =>
          applyEvent(qc, type, (e as MessageEvent).data, invalidateRuns),
        );
      }
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearTimeout(debounce);
      es?.close();
      setLive(false);
    };
  }, [qc, url]);
}
