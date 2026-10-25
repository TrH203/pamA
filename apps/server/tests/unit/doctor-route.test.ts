// GET /v1/doctor relays `pama doctor --report`; a missing binary is a 503, not a 500.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { pglite } from "../helpers/db.ts";

describe("doctor route", () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await makeCtx(pglite);
  });
  afterAll(() => t.close());
  afterEach(() => {
    delete process.env.PAMA_BIN;
  });

  it("returns the report even when a check failed (exit 1)", async () => {
    const bin = join(mkdtempSync(join(tmpdir(), "pama-doctor-")), "pama");
    writeFileSync(bin, `#!/bin/sh\necho '{"ok":false,"checks":[]}'\nexit 1\n`, { mode: 0o755 });
    process.env.PAMA_BIN = bin;
    const res = await t.req("/v1/doctor");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, checks: [] });
  });

  it("answers 503 when the pama binary cannot run", async () => {
    process.env.PAMA_BIN = "/nonexistent/pama";
    const res = await t.req("/v1/doctor");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "doctor_unavailable",
    );
  });
});
