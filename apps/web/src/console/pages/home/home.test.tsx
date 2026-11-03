// @vitest-environment jsdom
// Home: pipeline counts, needs attention (failed runs + doctor checks), recent runs, states.
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { counts, renderAt, run, stubApi } from "../activity/test-utils.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const failed = run({
  id: "01JC0000000000000000000005",
  status: "failed",
  stage: "received",
  error_code: "provider_auth",
  error_message: "Small model (openrouter qwen/qwen3-8b) rejected the API key",
  resumable: true,
  agent_session_id: "cafebabe-1",
});

describe("Home", () => {
  it("shows counts, what needs attention with fixes, and recent runs", async () => {
    const fetch = stubApi([
      [
        "/v1/activity?status=failed",
        { runs: [failed], next_cursor: null, counts: counts({ failed: 1 }) },
      ],
      [
        "/v1/activity",
        {
          runs: [run(), failed],
          next_cursor: null,
          counts: counts({ running: 2, awaiting_review: 3, failed: 1 }),
        },
      ],
      [
        "/v1/doctor",
        {
          checks: [
            { check: "hooks", ok: false, detail: "Claude Code hook missing", fix: "pama init" },
            { check: "daemon", ok: true, detail: "ok", fix: null },
          ],
        },
      ],
      ["POST /v1/activity/", { digest_id: "d", run_id: failed.id }],
    ]);
    renderAt("/");
    const pipeline = await screen.findByRole("region", { name: "Pipeline" });
    expect(await within(pipeline).findByText("3")).toBeTruthy();
    expect(
      within(pipeline)
        .getByRole("link", { name: /Running\s*2/ })
        .getAttribute("href"),
    ).toBe("/activity?status=running");
    expect(within(pipeline).getByRole("link", { name: /Failed\s*1/ })).toBeTruthy();

    const attention = screen.getByRole("region", { name: "Needs attention" });
    expect(
      await within(attention).findByText(/Digest failed: claude code · pama · cafebabe/),
    ).toBeTruthy();
    expect(within(attention).getByText("provider_auth")).toBeTruthy();
    expect(within(attention).getByRole("link", { name: /Open Settings/ })).toBeTruthy();
    expect(await within(attention).findByText("Check failed: hooks")).toBeTruthy();
    expect(within(attention).getByText("pama init")).toBeTruthy();
    expect(within(attention).queryByText("Check failed: daemon")).toBeNull();

    await userEvent.click(within(attention).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Retry started")).toBeTruthy();
    expect(fetch.mock.calls.some(([, i]) => i?.method === "POST")).toBe(true);

    const recent = screen.getByRole("region", { name: "Recent activity" });
    expect(within(recent).getAllByRole("listitem")).toHaveLength(2);
  });

  it("is all clear when nothing failed and doctor is unavailable (cloud)", async () => {
    stubApi([["/v1/activity", { runs: [], next_cursor: null, counts: counts() }]]);
    renderAt("/");
    expect(await screen.findByText("All clear")).toBeTruthy();
    expect(await screen.findByText("No pipeline runs yet")).toBeTruthy();
  });

  it("shows an error with retry when the pipeline cannot be loaded", async () => {
    let fail = true;
    stubApi([
      [
        "/v1/activity",
        () =>
          fail
            ? Response.json({ error: { code: "internal", message: "boom" } }, { status: 500 })
            : Response.json({ runs: [], next_cursor: null, counts: counts() }),
      ],
    ]);
    renderAt("/");
    expect(await screen.findByText("boom")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("All clear")).toBeTruthy();
  });
});
