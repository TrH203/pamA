// @vitest-environment jsdom
// Activity runs list, run detail (timeline, error, retry incl. 409s) and the Review empty state.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityPath, newerRunId, openFailures } from "./api.ts";
import { timeline } from "./format.ts";
import { counts, renderAt, run, stubApi } from "./test-utils.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const failedRun = run({
  id: "01JC0000000000000000000002",
  stage: "drafted",
  status: "failed",
  error_code: "provider_unreachable",
  error_message: "Embedding model (ollama bge-m3) is unreachable.",
  role: "embed",
  provider: "ollama",
  model: "bge-m3",
  resumable: true,
  agent_session_id: "deadbeef-1",
});

describe("Activity list", () => {
  it("shows runs and filters by status through the URL", async () => {
    const fetch = stubApi([
      [
        "/v1/activity",
        (url: string) =>
          Response.json({
            runs: url.includes("status=failed") ? [failedRun] : [run(), failedRun],
            next_cursor: null,
            counts: counts(),
          }),
      ],
    ]);
    const { router } = renderAt("/activity");
    const table = await screen.findByRole("region", { name: "Pipeline runs" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("provider_unreachable")).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText("Status"), "failed");
    await waitFor(() => expect(router.state.location.search).toEqual({ status: "failed" }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([u]) => String(u).includes("status=failed"))).toBe(true),
    );
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2));
  });

  it("shows an empty state, and a filtered empty state with a reset", async () => {
    stubApi([["/v1/activity", { runs: [], next_cursor: null, counts: counts() }]]);
    renderAt("/activity?since=%2224h%22");
    expect(await screen.findByText("No runs match these filters")).toBeTruthy();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Clear filters" })[0] as HTMLElement,
    );
    expect(await screen.findByText("No runs yet")).toBeTruthy();
  });

  it("shows an error with a working retry", async () => {
    let fail = true;
    stubApi([
      [
        "/v1/activity",
        () =>
          fail
            ? Response.json({ error: { code: "internal", message: "db down" } }, { status: 500 })
            : Response.json({ runs: [run()], next_cursor: null, counts: counts() }),
      ],
    ]);
    renderAt("/activity");
    expect(await screen.findByText("db down")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: "Pipeline runs" })).toBeTruthy();
  });

  it("loads the next page with the cursor", async () => {
    const fetch = stubApi([
      [
        "/v1/activity",
        (url: string) =>
          Response.json(
            url.includes("cursor=")
              ? { runs: [failedRun], next_cursor: null, counts: counts() }
              : { runs: [run()], next_cursor: run().id, counts: counts() },
          ),
      ],
    ]);
    renderAt("/activity");
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("provider_unreachable")).toBeTruthy();
    expect(fetch.mock.calls.some(([u]) => String(u).includes(`cursor=${run().id}`))).toBe(true);
  });
});

describe("Run detail", () => {
  it("shows the timeline, the coded error with its fix, and retries", async () => {
    const fetch = stubApi([
      [`/v1/activity/${failedRun.id}`, { run: failedRun }],
      ["POST /v1/activity/", { digest_id: "d1", run_id: failedRun.id }],
    ]);
    renderAt(`/activity/${failedRun.id}`);
    const steps = await screen.findByRole("list", { name: "Stages" });
    expect(within(steps).getByText("Classified").parentElement?.textContent).toContain(
      "failed here",
    );
    expect(within(steps).getByText("Drafted").parentElement?.textContent).toContain("done");
    expect(screen.getByText("Embedding model (ollama bge-m3) is unreachable.")).toBeTruthy();
    expect(screen.getByText("ollama serve")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open Settings/ })).toBeTruthy();
    expect(screen.getByText("pama logs server --follow")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Retry started")).toBeTruthy();
    expect(
      fetch.mock.calls.some(
        ([u, i]) => String(u).endsWith(`/${failedRun.id}/retry`) && i?.method === "POST",
      ),
    ).toBe(true);
  });

  it("explains a superseded retry and links to the newer run", async () => {
    const newer = "01JC0000000000000000000009";
    stubApi([
      [`/v1/activity/${newer}`, { run: run({ id: newer }) }],
      [`/v1/activity/${failedRun.id}`, { run: failedRun }],
      [
        "POST /v1/activity/",
        () =>
          Response.json(
            {
              error: {
                code: "superseded",
                message: `A newer run of this session exists (${newer}); retry that one instead.`,
              },
            },
            { status: 409 },
          ),
      ],
    ]);
    const { router } = renderAt(`/activity/${failedRun.id}`);
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("A newer run of this session exists; retry that one instead."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "View newer run" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/activity/${newer}`));
  });

  it("tells the owner to retry on the device when no draft was kept", async () => {
    const r = { ...failedRun, resumable: false, stage: "received" as const };
    stubApi([[`/v1/activity/${r.id}`, { run: r }]]);
    renderAt(`/activity/${r.id}`);
    expect(await screen.findByText("pama activity retry --all-failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows not found for an unknown run", async () => {
    stubApi([]);
    renderAt("/activity/01JC0000000000000000000404");
    expect(await screen.findByText("No run with this id")).toBeTruthy();
  });
});

describe("Review empty state", () => {
  it("reflects runs in flight and failures", async () => {
    stubApi([
      ["/v1/activity", { runs: [], next_cursor: null, counts: counts({ running: 2, failed: 1 }) }],
    ]);
    renderAt("/review");
    expect(await screen.findByText("2 sessions are being drafted · 1 session failed")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View" }).getAttribute("href")).toContain(
      "status=failed",
    );
  });

  it("falls back to the plain hint when the pipeline is idle", async () => {
    stubApi([["/v1/activity", { runs: [], next_cursor: null, counts: counts() }]]);
    renderAt("/review");
    expect(
      await screen.findByText("New sessions appear here a minute or two after they end."),
    ).toBeTruthy();
  });
});

describe("helpers", () => {
  it("builds activity URLs with since computed at fetch time", () => {
    const now = Date.parse("2026-11-03T10:00:00Z");
    expect(activityPath({ status: "failed", since: "1h", limit: 5 }, now)).toBe(
      "/v1/activity?status=failed&since=2026-11-03T09%3A00%3A00.000Z&limit=5",
    );
    expect(activityPath({})).toBe("/v1/activity");
  });

  it("finds the newer run id in a superseded message", () => {
    expect(newerRunId("exists (01JC0000000000000000000009); retry")).toBe(
      "01JC0000000000000000000009",
    );
    expect(newerRunId("no id")).toBeNull();
  });

  it("keeps only failures that are the latest run of their session", () => {
    const a1 = run({ id: "01A", status: "failed", agent_session_id: "a" });
    const a2 = run({ id: "01B", status: "succeeded", agent_session_id: "a" });
    const b1 = run({ id: "01C", status: "failed", agent_session_id: "b" });
    expect(openFailures([a1, b1], [a2]).map((r) => r.id)).toEqual(["01C"]);
  });

  it("marks approval once the digest is approved", () => {
    const steps = timeline(run({ digest_id: "d" }), {
      id: "d",
      status: "approved",
      approved_at: null,
    });
    expect(steps.find((s) => s.key === "approved")?.state).toBe("done");
    expect(steps.every((s) => s.state !== "failed")).toBe(true);
  });
});
