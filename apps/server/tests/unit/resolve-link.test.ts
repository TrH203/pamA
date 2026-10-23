import { afterEach, beforeEach, expect, it } from "vitest";
import { HttpError } from "../../src/http.ts";
import { resolveLink } from "../../src/policy/resolve-link.ts";
import { createLink, revokeLink } from "../../src/services/links.ts";
import { type Seeded, seed } from "../fixtures/seed.ts";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { describeEachDb } from "../helpers/db.ts";

describeEachDb("resolveLink", (f) => {
  let t: TestCtx;
  let s: Seeded;
  beforeEach(async () => {
    t = await makeCtx(f);
    s = await seed(t.deps);
  });
  afterEach(() => t.close());

  const link = (over: Record<string, unknown> = {}) =>
    createLink(t.deps, {
      title: "Refund policy",
      sources: [{ type: "bundle", id: s.bundleRefund }],
      access_mode: "open",
      ...over,
    });

  it("resolves sources to session ids at query time", async () => {
    const l = await link({ sources: [{ type: "project", id: s.projectA }] });
    const r = await resolveLink(t.db, l.slug);
    expect(new Set(r.allowedSessionIds)).toEqual(
      new Set([s.sessions["refund-1"], s.sessions["refund-2"], s.sessions["checkout-1"]]),
    );
    expect(r.allowedSessionIds).not.toContain(s.sessions["sandbox-1"]);
    expect(r.status).toBe("active");
  });

  it("always denies the workspace's default labels", async () => {
    await t.db.query("UPDATE workspaces SET default_deny_labels = $2 WHERE id = $1", [
      t.deps.workspaceId,
      ["customer"],
    ]);
    const l = await link({ deny_labels: ["infra"] });
    const r = await resolveLink(t.db, l.slug);
    expect(new Set(r.denyLabels)).toEqual(new Set(["infra", "customer"]));
  });

  it("expired and revoked links are gone (410)", async () => {
    const l = await link();
    await t.db.query(
      "UPDATE ask_links SET expires_at = now() - interval '1 minute' WHERE slug = $1",
      [l.slug],
    );
    await expect(resolveLink(t.db, l.slug)).rejects.toMatchObject({
      status: 410,
      code: "link_inactive",
    });
    const l2 = await link();
    await revokeLink(t.deps, l2.slug);
    await expect(resolveLink(t.db, l2.slug)).rejects.toBeInstanceOf(HttpError);
    await expect(resolveLink(t.db, "doesnotexist")).rejects.toMatchObject({ status: 404 });
  });

  it("serves the remaining sources when one disappears (degraded)", async () => {
    const l = await link({
      sources: [
        { type: "bundle", id: s.bundleRefund },
        { type: "bundle", id: s.bundleCheckout },
      ],
    });
    await t.db.query("DELETE FROM digest_items WHERE bundle_id = $1", [s.bundleCheckout]);
    await t.db.query("DELETE FROM digests WHERE session_id = $1", [s.sessions["checkout-1"]]);
    await t.db.query("DELETE FROM sessions WHERE bundle_id = $1", [s.bundleCheckout]);
    await t.db.query("DELETE FROM bundles WHERE id = $1", [s.bundleCheckout]);
    const r = await resolveLink(t.db, l.slug);
    expect(r.status).toBe("degraded");
    expect(r.allowedSessionIds.sort()).toEqual(
      [s.sessions["refund-1"], s.sessions["refund-2"]].sort(),
    );
  });

  it("rejects links over sources that are not approved or not owned", async () => {
    await expect(link({ sources: [{ type: "bundle", id: "nope" }] })).rejects.toMatchObject({
      status: 422,
    });
  });
});
