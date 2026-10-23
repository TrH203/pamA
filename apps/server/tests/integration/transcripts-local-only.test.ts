import { afterEach, beforeEach, expect, it } from "vitest";
import { makeCtx, type TestCtx, transcriptInput } from "../helpers/ctx.ts";
import { describeEachDb } from "../helpers/db.ts";

describeEachDb("POST /v1/transcripts/digest outside local mode", (f) => {
  let t: TestCtx;
  afterEach(() => t.close());

  for (const mode of ["selfhost", "cloud"] as const) {
    it(`is refused with 403 in ${mode} mode`, async () => {
      t = await makeCtx(f, { mode });
      const res = await t.app.request("/v1/transcripts/digest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(transcriptInput()),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "local_only" } });
    });
  }

  beforeEach(() => {});
});
