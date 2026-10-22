import { afterEach, beforeEach, expect, it } from "vitest";
import { applyRetention } from "../../src/jobs/retention.ts";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { describeEachDb } from "../helpers/db.ts";

describeEachDb("audit retention", (f) => {
  let t: TestCtx;
  beforeEach(async () => {
    t = await makeCtx(f);
  });
  afterEach(() => t.close());

  it("deletes asks older than the retention period only", async () => {
    for (const [id, age] of [
      ["old", 200],
      ["recent", 10],
    ] as const) {
      await t.db.query(
        `INSERT INTO asks (id, workspace_id, origin, question, status, created_at)
         VALUES ($1, $2, 'link', 'q', 'answered', now() - make_interval(days => $3))`,
        [id, t.deps.workspaceId, age],
      );
    }
    expect(await applyRetention(t.db, 180)).toMatchObject({ asks: 1 });
    const left = await t.db.query<{ id: string }>("SELECT id FROM asks");
    expect(left.map((r) => r.id)).toEqual(["recent"]);
  });
});
