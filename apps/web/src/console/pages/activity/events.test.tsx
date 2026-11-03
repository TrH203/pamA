// @vitest-environment jsdom
// useEvents: SSE events update the query cache; errors fall back to polling and reconnect with
// backoff.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityQueries, type RunPage } from "./api.ts";
import { counts, run } from "./test-utils.tsx";
import { backoff, POLL_MS, useEvents, usePollInterval } from "./useEvents.ts";

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, (e: MessageEvent) => void>();
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

let poll: number | false = 0;
function Probe() {
  useEvents();
  poll = usePollInterval();
  return null;
}

function mount() {
  const qc = new QueryClient();
  const page: RunPage = { runs: [], next_cursor: null, counts: counts({ failed: 0 }) };
  qc.setQueryData(activityQueries.summary.queryKey, page);
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
  return { qc, invalidate };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.all = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useEvents", () => {
  it("goes live on open and applies count and run events", async () => {
    const { qc, invalidate } = mount();
    const es = FakeEventSource.all[0] as FakeEventSource;
    expect(es.url).toBe("/v1/events");
    expect(poll).toBe(POLL_MS);
    act(() => es.onopen?.());
    expect(poll).toBe(false);

    act(() => es.emit("review.count", { awaiting_review: 4, failed: 2 }));
    const page = qc.getQueryData<RunPage>(activityQueries.summary.queryKey);
    expect(page?.counts.failed).toBe(2);
    expect(page?.counts.awaiting_review).toBe(4);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["review"] });

    const r = run({ id: "01X", status: "running", stage: "drafted" });
    act(() => es.emit("run.updated", r));
    expect(qc.getQueryData(activityQueries.run("01X").queryKey)).toEqual({ run: r });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["activity"] });

    act(() => es.emit("inbox.count", { forwarded: 1 }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inbox"] });
  });

  it("falls back to polling on error and reconnects with backoff", async () => {
    mount();
    const first = FakeEventSource.all[0] as FakeEventSource;
    act(() => first.onopen?.());
    act(() => first.onerror?.());
    expect(first.closed).toBe(true);
    expect(poll).toBe(POLL_MS);
    expect(FakeEventSource.all).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(backoff(1));
    });
    expect(FakeEventSource.all).toHaveLength(2);
    const second = FakeEventSource.all[1] as FakeEventSource;
    act(() => second.onerror?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(backoff(2) - 1);
    });
    expect(FakeEventSource.all).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(FakeEventSource.all).toHaveLength(3);
  });

  it("closes the stream on unmount", () => {
    mount();
    cleanup();
    expect((FakeEventSource.all[0] as FakeEventSource).closed).toBe(true);
  });

  it("caps the backoff", () => {
    expect(backoff(1)).toBe(1_000);
    expect(backoff(3)).toBe(4_000);
    expect(backoff(20)).toBe(60_000);
  });
});
