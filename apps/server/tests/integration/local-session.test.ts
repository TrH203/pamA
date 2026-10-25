// Local mode: the per-launch token is traded once for an httpOnly cookie; Host and Origin are checked.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { pglite } from "../helpers/db.ts";

describe("local console session", () => {
  let t: TestCtx;
  beforeEach(async () => {
    t = await makeCtx(pglite, { mode: "local" });
  });
  afterEach(() => t.close());

  const exchange = (token: string) =>
    t.app.request("/v1/auth/local-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });

  it("trades the token for a cookie that authenticates later requests", async () => {
    expect((await t.app.request("/v1/review")).status).toBe(401);
    expect((await exchange("wrong")).status).toBe(401);
    const res = await exchange(t.deps.config.localToken);
    expect(res.status).toBe(204);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    const cookie = set.split(";")[0] as string;
    expect((await t.app.request("/v1/review", { headers: { cookie } })).status).toBe(200);
  });

  it("refuses cross-origin cookie requests and foreign Host headers", async () => {
    const cookie = (
      (await exchange(t.deps.config.localToken)).headers.get("set-cookie") ?? ""
    ).split(";")[0] as string;
    const cross = await t.app.request("/v1/review", {
      headers: { cookie, host: "localhost:8787", origin: "http://evil.example" },
    });
    expect(cross.status).toBe(403);
    const rebound = await t.app.request("/v1/review", {
      headers: { cookie, host: "evil.example" },
    });
    expect(rebound.status).toBe(403);
  });
});
