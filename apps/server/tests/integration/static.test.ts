import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLink, revokeLink } from "../../src/services/links.ts";
import { seed } from "../fixtures/seed.ts";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { pglite } from "../helpers/db.ts";

describe("web pages", () => {
  let t: TestCtx;
  let slug: string;
  const web = mkdtempSync(join(tmpdir(), "pama-web-"));
  beforeAll(async () => {
    mkdirSync(join(web, "assets"));
    writeFileSync(join(web, "ask.html"), "<html>ASK PAGE</html>");
    writeFileSync(join(web, "console.html"), "<html>CONSOLE</html>");
    writeFileSync(join(web, "assets/app.js"), "console.log(1)");
    process.env.PAMA_WEB_DIR = web;
    t = await makeCtx(pglite);
    const s = await seed(t.deps);
    slug = (
      await createLink(t.deps, {
        sources: [{ type: "bundle", id: s.bundleRefund }],
        access_mode: "open",
      })
    ).slug;
  });
  afterAll(async () => {
    delete process.env.PAMA_WEB_DIR;
    await t.close();
  });

  it("serves the Ask Link page with security headers", async () => {
    const res = await t.app.request(`/a/${slug}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ASK PAGE");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("serves assets and blocks path traversal", async () => {
    expect((await t.app.request("/assets/app.js")).status).toBe(200);
    expect((await t.app.request("/assets/../../etc/passwd")).status).toBe(404);
  });

  it("shows no content for revoked links (410) and unknown links (404)", async () => {
    await revokeLink(t.deps, slug);
    const res = await t.app.request(`/a/${slug}`);
    expect(res.status).toBe(410);
    expect(await res.text()).not.toContain("ASK PAGE");
    expect((await t.app.request("/a/nosuchlink99")).status).toBe(404);
  });
});
